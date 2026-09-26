import { useEffect, useState } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Activity, Zap } from 'lucide-react';

/**
 * Live current waveform, one socket at a time.
 *
 * This is the measurement the whole load-identification story rests on: a
 * filament bulb draws a clean sine, a charger draws two narrow spikes per
 * cycle. Showing the trace next to a perfect sine of the same RMS makes the
 * difference visible without any of the numbers - the gap between the two
 * lines IS the classification.
 *
 * The data comes from /api/telemetry/signatures/, which serves the 64-point
 * averaged mains cycle the subnode captured. Each capture is 16 cycles
 * coherently averaged on the ESP32, which is what lifts a small load out of a
 * 30A ACS712's noise floor.
 */

// Categorical slots 1 and 2 of the validated palette - an adjacent pair chosen
// because they stay separable under colour-vision deficiency.
const MEASURED = '#2a78d6';
const REFERENCE = '#eb6834';

interface SignaturePoint {
  device_id: string;
  socket_id: number;
  label: string;
  description: string;
  confidence: number;
  reason: string;
  features: { crest: number; form_factor: number; conduction: number; thd: number };
  amplitude_adc_rms: number;
  cycle: number[];
  timestamp: string;
}

interface Props {
  token: string | null;
  apiBaseUrl: string;
}

const LABEL_TEXT: Record<string, string> = {
  RESISTIVE: 'Resistive - bulb, heater, iron',
  SMPS: 'Switching supply - charger, LED driver, TV',
  MIXED: 'Mixed - active PFC, or two loads',
  NONE: 'Nothing detected',
};

export const LiveWaveform = ({ token, apiBaseUrl }: Props) => {
  const [signatures, setSignatures] = useState<SignaturePoint[]>([]);
  const [socket, setSocket] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/telemetry/signatures/`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setSignatures(data.sockets || []);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'could not reach the backend');
      }
    };

    load();
    // The subnode captures one socket every 15s, so polling faster than this
    // only re-draws the same cycle.
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [token, apiBaseUrl]);

  const current = signatures.find((s) => s.socket_id === socket);

  // A pure sine at the same RMS AND the same phase as the measurement, so the
  // only thing that can separate the two lines is shape.
  //
  // The reference used to be drawn at a fixed phase, starting at zero and rising.
  // Whether the measurement does the same depends on which way current runs
  // through the ACS712 and where the capture anchored its zero crossing, so a
  // perfectly good bulb trace could come out drawn exactly half a cycle away
  // from the reference and read as a disagreement. It is not one: every feature
  // behind the verdict is computed on the RMS-normalised cycle and is invariant
  // to phase and sign, which is why the numbers were right while the picture
  // looked wrong.
  //
  // So the reference takes its phase from the measurement's own fundamental,
  // recovered with a single-bin DFT. For x[i] = A*sin(t + p):
  //     sum x[i]*sin(t) = (N/2)*A*cos(p)      -> a
  //     sum x[i]*cos(t) = (N/2)*A*sin(p)      -> b
  // and therefore p = atan2(b, a).
  const chartData = (() => {
    if (!current?.cycle?.length) return [];
    const cycle = current.cycle;
    const bins = cycle.length;
    const rms = Math.sqrt(cycle.reduce((a, v) => a + v * v, 0) / bins);

    let a = 0;
    let b = 0;
    for (let i = 0; i < bins; i++) {
      const t = (2 * Math.PI * i) / bins;
      a += cycle[i] * Math.sin(t);
      b += cycle[i] * Math.cos(t);
    }
    const phase = Math.atan2(b, a);

    return cycle.map((v, i) => {
      const t = (2 * Math.PI * i) / bins;
      return {
        ms: ((i / bins) * 20).toFixed(1),
        measured: Number(v.toFixed(4)),
        sine: Number((rms * Math.SQRT2 * Math.sin(t + phase)).toFixed(4)),
      };
    });
  })();

  return (
    <div className="p-5 sm:p-8 rounded-[1.75rem] sm:rounded-[2.5rem] bg-white border border-olive/10 soft-shadow">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-lg sm:text-xl font-display font-medium text-olive italic">
            Live Current Waveform
          </h3>
          <p className="text-[10px] text-ink/30 font-black uppercase tracking-wider mt-1">
            One mains cycle, measured at the socket
          </p>
        </div>

        <div className="flex gap-2">
          {[1, 2, 3].map((n) => {
            const sig = signatures.find((s) => s.socket_id === n);
            return (
              <button
                key={n}
                onClick={() => setSocket(n)}
                className={`px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  socket === n
                    ? 'bg-olive text-white shadow-sm'
                    : 'bg-bg-base text-ink/50 hover:bg-bg-card/40'
                }`}
              >
                Socket {n}
                {sig && (
                  <span className="block text-[9px] font-bold normal-case tracking-normal opacity-70">
                    {sig.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <p className="text-xs font-semibold text-danger mb-4">
          {error}
        </p>
      )}

      {!current || chartData.length === 0 ? (
        <div className="h-72 flex flex-col items-center justify-center gap-3 text-center">
          <Activity className="w-8 h-8 text-ink/20" />
          <p className="text-sm font-semibold text-ink/50">
            No waveform captured for socket {socket} yet
          </p>
          <p className="text-[11px] text-ink/35 max-w-md leading-relaxed">
            The socket has to be switched on and drawing before it can be measured.
            A load below the sensor's noise floor - a phone charger, anything in
            standby - stays invisible on a 30A sensor.
          </p>
        </div>
      ) : (
        <>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="#E4E0D2" strokeWidth={0.8} vertical={false} />
                <XAxis
                  dataKey="ms"
                  tick={{ fontSize: 10, fill: '#3E423A80' }}
                  tickLine={false}
                  axisLine={{ stroke: '#E4E0D2' }}
                  interval={7}
                  label={{
                    value: 'Time within one mains cycle (ms)',
                    position: 'insideBottom',
                    offset: -4,
                    style: { fontSize: 10, fill: '#3E423A80' },
                  }}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#3E423A80' }}
                  tickLine={false}
                  axisLine={{ stroke: '#E4E0D2' }}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    border: '1px solid #E4E0D2',
                    fontSize: 12,
                  }}
                  labelFormatter={(v) => `${v} ms`}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Line
                  type="monotone"
                  dataKey="sine"
                  name="Pure sine (same RMS and phase)"
                  stroke={REFERENCE}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="measured"
                  name="Measured current"
                  stroke={MEASURED}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-6 pt-5 border-t border-olive/10">
            <div className="flex items-center gap-2 mb-3">
              <Zap size={16} className="text-clay" />
              <span className="text-sm font-bold text-ink">
                {LABEL_TEXT[current.label] || current.label}
              </span>
              <span className="text-[11px] font-semibold text-ink/40">
                {Math.round(current.confidence * 100)}% confident
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-[11px]">
              {[
                ['Crest factor', current.features.crest.toFixed(2), '1.41 = pure sine'],
                ['Form factor', current.features.form_factor.toFixed(2), '1.11 = pure sine'],
                ['Conduction', `${Math.round(current.features.conduction * 100)}%`, 'of the cycle'],
                ['THD', current.features.thd.toFixed(2), '0 = pure sine'],
              ].map(([label, value, hint]) => (
                <div key={label}>
                  <p className="text-ink/35 font-black uppercase tracking-wider text-[9px]">{label}</p>
                  <p className="text-ink font-bold text-base">{value}</p>
                  <p className="text-ink/30">{hint}</p>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-ink/40 mt-4 leading-relaxed">
              {current.reason}
            </p>
          </div>
        </>
      )}
    </div>
  );
};
