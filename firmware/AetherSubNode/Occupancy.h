#ifndef AETHER_OCCUPANCY_H
#define AETHER_OCCUPANCY_H

// ============================================================================
// Occupancy tracking and the socket cutoff rule
// ============================================================================
// Decides when a socket is wasting power and should be opened.
//
// The honest constraint this is built around: a 30A ACS712 has a measured noise
// floor of about 1.5 ADC RMS steps, and a device in true standby draws 2-5W,
// which is roughly 0.5 steps. Standby is INVISIBLE to this sensor. A rule that
// waits to detect a small phantom draw would therefore never fire.
//
// So the rule is built on what the hardware can actually see:
//
//   the socket is closed, something is drawing, and nobody has been in the
//   room for N minutes  ->  that is waste, whatever its size
//
// A lamp left burning in an empty room is caught by this. So is a charger still
// pulling current with nobody there. Both are real waste and both are visible.
// Sub-watt vampire draw is not, and measuring it needs the gateway's metering
// or a PZEM - claiming otherwise on this sensor would be false.
//
// PIR reports MOTION, not presence: someone sitting still reads as absent
// within a minute or two. That is exactly why the rule needs both signals. The
// grace period is what stops a still occupant being cut off, and it is why the
// default is minutes rather than seconds.
// ============================================================================

#include <Arduino.h>
#include <Preferences.h>
#include <string.h>   // strcmp, for the load-type policy below

#define OCC_SOCKETS 3

// Anything at or below this is the sensor's own noise, not a load. Measured on
// the rig at 1.5 ADC RMS; 3.0 leaves headroom. Matches WF_NOISE_FLOOR_ADC.
#define OCC_NOISE_FLOOR_ADC 3.0f

// Below this but above the noise floor means "drawing, but only just" - an
// idling supply rather than something in use. On this sensor the band is narrow;
// it widens considerably with a more sensitive current sensor.
#define OCC_IDLE_BAND_ADC 8.0f

struct OccupancyState {
    bool motionNow = false;
    uint32_t lastMotionMs = 0;
    uint32_t motionEvents = 0;
    bool everSeenMotion = false;
};

struct SocketState {
    bool relayClosed = false;
    float currentAdc = 0;          // latest amplitude, ADC RMS steps
    const char* loadType = "NONE"; // from waveform classification
    bool cutByRule = false;        // opened by the cutoff rule, not by a human
    uint32_t cutAtMs = 0;
    // What was flowing at the instant of the cut. Held separately because
    // currentAdc drops to zero the moment the relay opens - accumulating the
    // saving from the live reading would therefore always add nothing.
    float currentAtCutAdc = 0;
    float savedAdcSeconds = 0;     // crude integral of what was cut, see below
    // Set when the socket draws current while commanded open - welded
    // contacts. The socket cannot be switched off in that state.
    bool contactsStuck = false;
};

struct CutoffConfig {
    // Seconds of no motion before an active load is considered waste. Five
    // minutes is sane for a room; drop it to 20-30s for a demo.
    uint32_t graceSeconds = 300;
    // Idling loads are cut sooner - nobody is mid-use of something that is
    // only trickling.
    uint32_t idleGraceSeconds = 60;
    // Armed by default. This was false for a while, and because it lived only
    // in RAM the node came up disarmed after every reflash and every brownout -
    // so the rule looked broken when it was merely switched off, silently. The
    // three fields above have the same problem, so all three now persist.
    bool enabled = true;
};

// ---------------------------------------------------------------------------
// Persistence for the three fields above. Whatever the rule is set to should
// survive a power cut, because a safety-adjacent rule that quietly forgets it
// was enabled is worse than one that was never enabled at all: the dashboard
// still claims it is watching.
// ---------------------------------------------------------------------------
static Preferences occPrefs;

inline void occSaveConfig(const CutoffConfig& config) {
    occPrefs.begin("cutoff", false);
    occPrefs.putBool("enabled", config.enabled);
    occPrefs.putUInt("grace", config.graceSeconds);
    occPrefs.putUInt("idle", config.idleGraceSeconds);
    occPrefs.end();
}

// Call from setup(), before the first occDecide(). Missing keys fall back to
// the struct defaults, so a node flashed for the first time comes up armed.
inline void occLoadConfig(CutoffConfig& config) {
    occPrefs.begin("cutoff", true);
    config.enabled         = occPrefs.getBool("enabled", config.enabled);
    config.graceSeconds    = occPrefs.getUInt("grace",   config.graceSeconds);
    config.idleGraceSeconds = occPrefs.getUInt("idle",   config.idleGraceSeconds);
    occPrefs.end();
}

struct CutoffDecision {
    bool shouldCut = false;
    const char* reason = "";
};

// ---------------------------------------------------------------------------
// Poll the PIR. The HC-SR501 latches its own output high for as long as its
// time-delay pot is set to, which is why that pot should be turned right down -
// the useful timing lives here, where it can be changed without a screwdriver.
// ---------------------------------------------------------------------------
inline void occUpdate(OccupancyState& state, int pirPin) {
    const bool motion = digitalRead(pirPin) == HIGH;
    if (motion && !state.motionNow) state.motionEvents++;
    if (motion) {
        state.lastMotionMs = millis();
        state.everSeenMotion = true;
    }
    state.motionNow = motion;
}

// Call once from setup(). Starts the no-motion clock at boot rather than at
// the epoch, so a freshly powered node does not believe the room has been empty
// forever and cut every socket the instant the rule is armed.
inline void occBegin(OccupancyState& state) {
    state.lastMotionMs = millis();
}

// Seconds since motion was last seen - or since boot, if it never has been.
// Deliberately no "infinity" case: an unknown room should get the same grace
// period as an empty one, not an instant cutoff.
inline uint32_t occSecondsSinceMotion(const OccupancyState& state) {
    return (millis() - state.lastMotionMs) / 1000;
}

inline bool occRoomOccupied(const OccupancyState& state, uint32_t graceSeconds) {
    return occSecondsSinceMotion(state) < graceSeconds;
}

// ---------------------------------------------------------------------------
// The cutoff decision for one socket.
//
// Cut only when every one of these holds:
//   - the rule is armed
//   - the relay is closed, so there is something to cut
//   - current is above the noise floor, so something is genuinely drawing
//   - no motion for longer than the applicable grace period
//
// The current check is what protects a still occupant. If a load is drawing
// hard it is more likely in use, so it gets the full grace period; something
// merely idling gets the shorter one.
// ---------------------------------------------------------------------------
inline CutoffDecision occEvaluate(const SocketState& socket,
                                  const OccupancyState& occupancy,
                                  const CutoffConfig& config) {
    CutoffDecision decision;

    if (!config.enabled) {
        decision.reason = "rule not armed";
        return decision;
    }
    if (!socket.relayClosed) {
        decision.reason = "already open";
        return decision;
    }
    if (socket.currentAdc < OCC_NOISE_FLOOR_ADC) {
        // Nothing measurable is flowing. Either the socket is empty or the load
        // is in standby below what this sensor can resolve - cutting on this
        // would mean cutting on noise.
        decision.reason = "nothing drawing (or below the noise floor)";
        return decision;
    }

    const bool idling = socket.currentAdc < OCC_IDLE_BAND_ADC;
    const uint32_t quiet = occSecondsSinceMotion(occupancy);

    // What is plugged in decides whether an empty room means waste.
    //
    // Occupancy answers "is anyone here", which is the whole story for a light
    // and almost none of it for a charger. A bulb burning in an empty room is
    // waste by definition - nobody is seeing the light. A phone charging in an
    // empty room is doing exactly its job, and cutting it because you left the
    // room would make the system infuriating rather than useful.
    //
    // The load type comes from the current waveform, so this needs no setup and
    // no labelling: move the bulb to another socket and the policy follows it.
    const bool isLighting = socket.loadType && strcmp(socket.loadType, "RESISTIVE") == 0;
    const bool isSupply   = socket.loadType && strcmp(socket.loadType, "SMPS") == 0;

    uint32_t grace;
    if (isLighting) {
        // Serves the room, so an empty room is enough on its own.
        grace = config.graceSeconds;
    } else if (isSupply) {
        // Only cut a switching supply once it has dropped to the idle band -
        // that is a charger that has finished, not one still doing work.
        if (!idling) {
            decision.reason = "switching supply still drawing - charging, left alone";
            return decision;
        }
        grace = config.idleGraceSeconds;
    } else {
        // MIXED, or not yet identified. Be conservative and treat it the way a
        // supply is treated: require it to be idling before cutting anything.
        if (!idling) {
            decision.reason = "unidentified load still drawing - left alone";
            return decision;
        }
        grace = config.idleGraceSeconds;
    }

    if (quiet < grace) {
        decision.reason = "room occupied recently";
        return decision;
    }

    decision.shouldCut = true;
    decision.reason = isLighting ? "light left on in an empty room"
                    : isSupply   ? "supply finished charging, nobody present"
                                 : "idle load, nobody present";
    return decision;
}

// ---------------------------------------------------------------------------
// Rough energy saved, in ADC-step-seconds. Deliberately NOT converted to watts
// or rupees here.
//
// The subnode measures current only. Turning that into watts means assuming a
// voltage and a power factor, and the power factor assumption is the one that
// breaks: a charger drawing 60 VA may consume 35 W, so a naive figure overstates
// the saving by most of half. The gateway measures voltage and current together
// and can state real watts; the backend should scale these step-seconds using
// the gateway's concurrent power factor rather than guessing here.
// ---------------------------------------------------------------------------
inline void occAccumulateSaving(SocketState& socket, uint32_t elapsedMs) {
    if (!socket.cutByRule) return;
    socket.savedAdcSeconds += socket.currentAtCutAdc * (elapsedMs / 1000.0f);
}

inline const char* occLoadBand(const SocketState& socket) {
    if (socket.currentAdc < OCC_NOISE_FLOOR_ADC) return "none";
    if (socket.currentAdc < OCC_IDLE_BAND_ADC) return "idling";
    return "active";
}

#endif  // AETHER_OCCUPANCY_H
