/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Zap,
  ShieldAlert,
  Cpu,
  Activity,
  Wind,
  Lightbulb,
  Power,
  ChevronRight,
  AlertTriangle,
  Globe,
  Plus,
  X
} from 'lucide-react';
import {
  AreaChart,
  Area,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { cn } from './lib/utils';
import {
  getSmartMacroSuggestions,
  getEnergyInsights,
  SmartRule,
  EnergyInsight
} from './services/geminiService';

// Import refactored components
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { AnalyticsView } from './components/AnalyticsView';
import { AutomationView } from './components/AutomationView';
import { ManualControlView } from './components/ManualControlView';
import { SafetyHubView } from './components/SafetyHubView';
import { SafetyAlertOverlay } from './components/SafetyAlertOverlay';
import { EventsView } from './components/EventsView';
import { SettingsView } from './components/SettingsView';
import { sendHazardNotification, showImmediateHazardNotification } from './services/pwaService';

// Import refactored hook
import { useAudioAlert } from './hooks/useAudioAlert';

// Room Architect replaces the old three.js Digital Twin. Still lazy-loaded:
// it is the largest view in the app and most sessions never open it.
const RoomArchitectView = lazy(() => import('./components/RoomArchitectView'));
const HAZARD_ALERT_RESET_MS = 10000;

// --- Mock Data ---
const generateChartData = (range: string = 'Daily') => {
  const points = range === 'Daily' ? 24 : range === 'Weekly' ? 7 : 30;
  return Array.from({ length: points }, (_, i) => ({
    name: range === 'Daily' ? `${i}:00` : range === 'Weekly' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i] : `Day ${i + 1}`,
    value: Math.floor(Math.random() * 400) + 100,
    previous: Math.floor(Math.random() * 350) + 150,
  }));
};

const mapApplianceToZone = (app: any) => {
  let icon = Zap;
  let color = 'text-olive';
  if (app.type === 'Lights') {
    icon = Lightbulb;
    color = 'text-clay';
  } else if (app.type === 'HVAC') {
    icon = Wind;
    color = 'text-sage';
  } else if (app.type === 'Samsung TV' || app.type === 'Media Unit') {
    icon = Activity;
    color = 'text-ink';
  }
  return {
    id: `app-socket-${app.id}`,
    appliance_id: app.id,
    name: app.name,
    type: app.type,
    icon: icon,
    active: app.active,
    status: app.active ? 'Active' : (app.type === 'HVAC' ? 'Standby' : 'Idle'),
    nominalConsumption: app.nominal_consumption,
    color: color,
    dailyAvg: `${(app.nominal_consumption * 0.004).toFixed(1)} kWh`,
    rules: [
      { text: `Auto-off if unoccupied > 15m`, active: true }
    ],
    history: [app.active ? app.nominal_consumption : 0, 45, 20, 60, 45, 50, 45],
    historyPrev: [25, 40, 30, 55, 40, 45, 40],
    lastOptimized: 'Just now',
    startTime: app.active ? Date.now() - 3600000 : null
  };
};

interface Zone {
  id: string;
  appliance_id?: number;
  name: string;
  type: string;
  icon: React.ComponentType<any>;
  active: boolean;
  status: string;
  nominalConsumption: number;
  color: string;
  dailyAvg: string;
  rules: { text: string; active: boolean }[];
  history: number[];
  historyPrev: number[];
  lastOptimized: string;
  startTime: number | null;
}

export default function App() {
  const [activeView, setActiveView] = useState(() => {
    const view = new URLSearchParams(window.location.search).get('view');
    return view || 'dashboard';
  });
  const [isEcoMode, setIsEcoMode] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSecurityLocked, setIsSecurityLocked] = useState(() => {
    const saved = localStorage.getItem('aether_user');
    return saved ? JSON.parse(saved).is_security_locked ?? true : true;
  });
  const [isFlame, setIsFlame] = useState(false);
  const [gasLevel, setGasLevel] = useState(120);
  const [showOverlay, setShowOverlay] = useState<null | 'fire' | 'gas'>(null);
  const [isMuted, setIsMuted] = useState(false);
  // Tracks whether a safety reset has been performed; hides the restore button afterwards
  const [resetCompleted, setResetCompleted] = useState(false);
  const [wasGasLeak, setWasGasLeak] = useState(false);
  const [wasFire, setWasFire] = useState(false);
  const wasGasLeakRef = useRef(false);
  const wasFireRef = useRef(false);
  const hazardSafeSinceRef = useRef<number | null>(Date.now());
  const [systemStatus, setSystemStatus] = useState('SAFE');
  const [gatewayMac, setGatewayMac] = useState('');
  const [liveTelemetry, setLiveTelemetry] = useState<any>({ gas: 0, current: 0, pir: 1, flame: 1, status: 'SAFE' });
  const [sensorData, setSensorData] = useState<any[]>([]);
  const [hazardRisk, setHazardRisk] = useState<any>(null);
  const [anomalyResult, setAnomalyResult] = useState<any>(null);
  const [energyRecommendations, setEnergyRecommendations] = useState<any>(null);
  const [apiStatus, setApiStatus] = useState({
    hazard: 'connecting',
    anomaly: 'connecting',
    recommendations: 'connecting'
  });

  const [token, setToken] = useState(() => {
    const saved = localStorage.getItem('aether_user');
    return saved ? JSON.parse(saved).token || '' : '';
  });
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    const saved = localStorage.getItem('aether_user');
    return saved ? true : false;
  });
  const [username, setUsername] = useState(() => {
    const saved = localStorage.getItem('aether_user');
    return saved ? JSON.parse(saved).username : '';
  });
  const [meshId, setMeshId] = useState(() => {
    const saved = localStorage.getItem('aether_user');
    return saved ? JSON.parse(saved).mesh_id : '';
  });
  const [meshKey, setMeshKey] = useState(() => {
    const saved = localStorage.getItem('aether_user');
    return saved ? JSON.parse(saved).mesh_key : '';
  });

  const checkAuth = async () => {
    const saved = localStorage.getItem('aether_user');
    let currentToken = '';
    if (saved) {
      try {
        const user = JSON.parse(saved);
        setIsAuthenticated(true);
        setUsername(user.username);
        setMeshId(user.mesh_id);
        setMeshKey(user.mesh_key);
        currentToken = user.token || '';
        setToken(currentToken);
      } catch (e) {
        console.error("Failed to parse cached auth in App:", e);
      }
    }

    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      const t = currentToken || token;
      if (t) {
        headers['Authorization'] = `Bearer ${t}`;
      }
      const res = await fetch(`${apiUrl}/api/accounts/me/`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          setIsAuthenticated(true);
          setUsername(data.username);
          setMeshId(data.mesh_id);
          setMeshKey(data.mesh_key);
          setIsSecurityLocked(data.is_security_locked);
          localStorage.setItem('aether_user', JSON.stringify({
            token: t,
            username: data.username,
            mesh_id: data.mesh_id,
            mesh_key: data.mesh_key,
            is_security_locked: data.is_security_locked
          }));

          // Fetch user devices to look up the Central Gateway's MAC Address and load appliances
          try {
            const devRes = await fetch(`${apiUrl}/api/devices/`, { headers });
            if (devRes.ok) {
              const devData = await devRes.json();
              // Identify the central controller, which may be a gateway or a relay device
              const gw = devData.devices.find((d: any) => d.role === 'gateway' || d.role === 'relay');
              if (gw) {
                setGatewayMac(gw.mac_address);
              }
              const allAppliances: any[] = [];
              devData.devices.forEach((d: any) => {
                if (d.appliances && d.appliances.length > 0) {
                  d.appliances.forEach((app: any) => {
                    allAppliances.push(mapApplianceToZone(app));
                  });
                }
              });
              if (allAppliances.length > 0) {
                setZones(allAppliances);
              }
            }
          } catch (devErr) {
            console.error("Failed to fetch user devices on mount:", devErr);
          }
        }
      } else {
        setIsAuthenticated(false);
        setUsername('');
        setMeshId('');
        setMeshKey('');
        setToken('');
        localStorage.removeItem('aether_user');
      }
    } catch (e) {
      console.error("Failed to check auth:", e);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);
  const [zones, setZones] = useState<Zone[]>([
    {
      id: 'lr-lights',
      name: 'Living Room',
      type: 'Lights',
      icon: Lightbulb,
      active: true,
      status: 'Active',
      nominalConsumption: 45, // W
      color: 'text-clay',
      dailyAvg: '1.2 kWh',
      rules: [{ text: 'Dim at 10 PM', active: true }, { text: 'Auto-off if unoccupied > 15m', active: true }],
      history: [30, 45, 20, 60, 45, 50, 45],
      historyPrev: [25, 40, 30, 55, 40, 45, 40],
      lastOptimized: '2h ago',
      startTime: Date.now() - 3600000 // 1h ago
    },
    {
      id: 'kitchen-app',
      name: 'Smart Charger',
      type: 'Appliance',
      icon: Zap,
      active: true,
      status: 'Active',
      nominalConsumption: 15, // W (Typical charger draw)
      color: 'text-olive',
      dailyAvg: '4.8 kWh',
      rules: [{ text: 'Heater priority off during peak', active: true }, { text: 'Standby isolation', active: false }],
      history: [1200, 1100, 1300, 1200, 1250, 1200, 1200],
      historyPrev: [1100, 1050, 1200, 1150, 1100, 1150, 1100],
      lastOptimized: '4h ago',
      startTime: Date.now() - 15735000 // approx 4.3h ago
    },
    {
      id: 'hvac',
      name: 'Thermostat',
      type: 'HVAC',
      icon: Wind,
      active: false,
      status: 'Standby',
      nominalConsumption: 800, // W
      color: 'text-sage',
      dailyAvg: '8.4 kWh',
      rules: [{ text: 'Maintain 22°C', active: true }, { text: 'Humidity exhaust over 60%', active: true }],
      history: [200, 150, 250, 200, 220, 210, 200],
      historyPrev: [180, 140, 230, 190, 210, 200, 190],
      lastOptimized: 'Just now',
      startTime: null
    },
    {
      id: 'tv-unit',
      name: 'Media Unit',
      type: 'Samsung TV',
      icon: Activity,
      active: false,
      status: 'Idle',
      nominalConsumption: 150, // W
      color: 'text-ink',
      dailyAvg: '0.9 kWh',
      rules: [{ text: 'Master switch off after 1 AM', active: false }, { text: 'Child lock enabled', active: true }],
      history: [0, 50, 10, 0, 0, 40, 0],
      historyPrev: [0, 60, 20, 0, 0, 30, 0],
      lastOptimized: '6h ago',
      startTime: null
    }
  ]);

  // Derived Stats
  const systemMetrics = useMemo(() => {
    const activeNodes = zones.filter(z => z.active);
    const totalLoad = activeNodes.reduce((acc, z) => {
      let consumption = z.nominalConsumption;
      if (isEcoMode && z.active) consumption *= 0.7; // 30% reduction in eco mode
      return acc + consumption;
    }, 0);

    const activeCount = activeNodes.length;
    const efficiency = activeCount > 0 ? (98.5 - (activeCount * 0.4)).toFixed(1) : '100';
    const dailySpend = (totalLoad * 0.024 * 7.5).toFixed(2); // Mock calculation

    return {
      totalLoad: (totalLoad / 1000).toFixed(2), // kW
      activeCount,
      efficiency,
      dailySpend
    };
  }, [zones, isEcoMode]);

  const [data, setData] = useState(generateChartData());

  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';

  const authHeaders = (withJson = true): HeadersInit => {
    const headers: HeadersInit = {};
    if (withJson) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  };

  const fetchAiSuggestions = async () => {
    setIsAiLoading(true);
    addToast("Consulting Mesh Intelligence...", Cpu);
    const suggestions = await getSmartMacroSuggestions(zones);
    setAiSuggestions(suggestions);
    setIsAiLoading(false);
  };

  const fetchEnergyInsights = async () => {
    setIsInsightLoading(true);
    const insights = await getEnergyInsights(systemMetrics, zones);
    setEnergyInsight(insights);
    setIsInsightLoading(false);
  };

  const fetchEnergyRecommendations = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/recommendations/energy/?days=30`, {
        headers: authHeaders()
      });
      if (!res.ok) {
        setApiStatus(prev => ({ ...prev, recommendations: 'offline' }));
        return;
      }
      const payload = await res.json();
      setEnergyRecommendations(payload);
      setApiStatus(prev => ({ ...prev, recommendations: 'live' }));
    } catch (err) {
      console.error("Error fetching AI energy recommendations:", err);
      setApiStatus(prev => ({ ...prev, recommendations: 'offline' }));
    }
  };

  useEffect(() => {
    if (activeView === 'analytics' && !energyInsight && !isInsightLoading) {
      fetchEnergyInsights();
    }
  }, [activeView]);

  useEffect(() => {
    fetchEnergyRecommendations();
    const interval = setInterval(fetchEnergyRecommendations, 60000);
    return () => clearInterval(interval);
  }, [token]);

  const [selectedZone, setSelectedZone] = useState<null | typeof zones[0]>(null);
  const [analyticsRange, setAnalyticsRange] = useState('Week');
  const [aiSuggestions, setAiSuggestions] = useState<SmartRule[]>([]);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [energyInsight, setEnergyInsight] = useState<EnergyInsight | null>(null);
  const [isInsightLoading, setIsInsightLoading] = useState(false);
  const [zoneRange, setZoneRange] = useState('Daily');
  const [isComparing, setIsComparing] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; message: string; icon: any }[]>([]);
  const [showRuleBuilder, setShowRuleBuilder] = useState(false);
  const [newRule, setNewRule] = useState({ condition: 'Time of Day', action: 'Turn Off', value: '' });

  const addToast = (message: string, icon: any) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [{ id, message, icon }, ...prev].slice(0, 3));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const removeToast = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const addAutomationRule = () => {
    if (!selectedZone) return;
    const ruleText = `${newRule.action}${newRule.value ? ' (' + newRule.value + ')' : ''} if ${newRule.condition}`;
    const ruleObj = { text: ruleText, active: true };
    setZones(prev => prev.map(z => {
      if (z.id === selectedZone.id) {
        return { ...z, rules: [...z.rules, ruleObj] };
      }
      return z;
    }));
    // Update local selectedZone so UI refreshes immediately
    setSelectedZone(prev => prev ? { ...prev, rules: [...prev.rules, ruleObj] } : null);
    addToast("Automation rule deployed to mesh", Cpu);
    setShowRuleBuilder(false);
  };

  const toggleRule = (zoneId: string, ruleIndex: number) => {
    setZones(prev => prev.map(z => {
      if (z.id === zoneId) {
        const newRules = [...z.rules];
        newRules[ruleIndex] = { ...newRules[ruleIndex], active: !newRules[ruleIndex].active };
        addToast(
          `Protocol ${newRules[ruleIndex].active ? 'engaged' : 'suspended'} for ${z.name}`,
          newRules[ruleIndex].active ? Cpu : ShieldAlert
        );
        return { ...z, rules: newRules };
      }
      return z;
    }));
  };

  const toggleZone = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const zone = zones.find(z => z.id === id);
    if (!zone) return;

    const nextActive = !zone.active;
    
    // Optimistic local state update
    setZones(prev => prev.map(z => {
      if (z.id === id) {
        return {
          ...z,
          active: nextActive,
          status: nextActive ? 'Active' : (z.type === 'HVAC' ? 'Standby' : 'Idle'),
          startTime: nextActive ? Date.now() : null
        };
      }
      return z;
    }));

    addToast(
      `${zone.name} node ${nextActive ? 'activated' : 'isolated'}`,
      nextActive ? Zap : Power
    );

    if (zone.appliance_id || zone.id) {
      try {
        const headers = authHeaders();
        const res = await fetch(`${apiBaseUrl}/api/devices/appliance/toggle/`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ 
            appliance_id: zone.appliance_id || null, 
            hardcoded_id: zone.appliance_id ? null : zone.id,
            active: nextActive 
          })
        });
        if (!res.ok) {
          // Revert on failure
          setZones(prev => prev.map(z => {
            if (z.id === id) {
              return {
                ...z,
                active: zone.active,
                status: zone.status,
                startTime: zone.startTime
              };
            }
            return z;
          }));
          addToast("Failed to communicate with relay node.", ShieldAlert);
        }
      } catch (err) {
        console.error("Error toggling backend appliance:", err);
      }
    }
  };

  useAudioAlert(!!showOverlay && !isMuted);

  useEffect(() => {
    const fetchTelemetry = async () => {
      try {
        const headers = authHeaders();
        const res = await fetch(`${apiBaseUrl}/api/telemetry/latest/?mesh_id=${meshId}`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        const rawGas = Number(data.gas || 0);
        const rawCurrent = Number(data.current || 0);
        const rawPower = Number(data.Power ?? data.power ?? 0);
        const rawPir = Number(data.pir ?? 1);
        const rawFlame = Number(data.flame ?? 1);
        setLiveTelemetry(data);

        // Scale 12-bit ADC value (0-4095) down to UI scale (e.g., 3500 raw -> 350)
        const uiGasLevel = rawGas / 10;
        setGasLevel(uiGasLevel);

        const status = String(data.status || 'SAFE').toUpperCase();

        const hasValidData = data.timestamp !== null;

        // flame == 0 means fire detected (Active-LOW)
        const fireDetected = hasValidData && rawFlame === 0;
        setIsFlame(fireDetected);

        const isGasLeak = hasValidData && rawGas >= 3500;
        const isFire = fireDetected;

        if (isFire && !wasFireRef.current) {
          hazardSafeSinceRef.current = null;
          wasFireRef.current = true;
          setShowOverlay('fire');
          void showImmediateHazardNotification({
            title: 'AETHER fire alert',
            message: 'Flame sensor triggered. Check the safety hub immediately.',
            tag: 'aether-fire-alert',
          });
          void sendHazardNotification(token, {
            hazard_type: 'FIRE',
            severity: 'critical',
            title: 'AETHER fire alert',
            message: 'Flame sensor triggered. Check the safety hub immediately.',
          });
        } else if (isGasLeak && !wasGasLeakRef.current && !isFire) {
          hazardSafeSinceRef.current = null;
          wasGasLeakRef.current = true;
          setShowOverlay('gas');
          void showImmediateHazardNotification({
            title: 'AETHER gas leak alert',
            message: `Gas level is high (${rawGas}). Ventilate and inspect the mesh zone immediately.`,
            tag: 'aether-gas-alert',
          });
          void sendHazardNotification(token, {
            hazard_type: 'GAS_LEAK',
            severity: 'critical',
            title: 'AETHER gas leak alert',
            message: `Gas level is high (${rawGas}). Ventilate and inspect the mesh zone immediately.`,
          });
        } else if (isGasLeak || isFire) {
          hazardSafeSinceRef.current = null;
        } else if (!isGasLeak && !isFire) {
          setShowOverlay(null);
          const now = Date.now();
          if (hazardSafeSinceRef.current === null) {
            hazardSafeSinceRef.current = now;
          }
          if (now - hazardSafeSinceRef.current >= HAZARD_ALERT_RESET_MS) {
            wasGasLeakRef.current = false;
            wasFireRef.current = false;
          }
        }

        setWasGasLeak(wasGasLeakRef.current);
        setWasFire(wasFireRef.current);
        setSystemStatus(data.status || 'SAFE');

        try {
          const hazardRes = await fetch(`${apiBaseUrl}/api/hazards/predict/`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              gas: rawGas,
              flame: rawFlame,
              device_mac: data.device_mac || gatewayMac,
              trigger_actions: false
            })
          });
          if (hazardRes.ok) {
            const hazardPayload = await hazardRes.json();
            setHazardRisk(hazardPayload);
            setApiStatus(prev => ({ ...prev, hazard: 'live' }));
            setSensorData(prev => {
              const nextPoint = {
                name: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                current: rawCurrent,
                Power: rawPower,
                power: rawPower,
                gas: Math.round(rawGas / 10),
                risk: hazardPayload.risk_score ?? 0
              };
              return [...prev.slice(-23), nextPoint];
            });
          } else {
            setApiStatus(prev => ({ ...prev, hazard: 'offline' }));
          }
        } catch (hazardErr) {
          console.error("Error fetching hazard prediction:", hazardErr);
          setApiStatus(prev => ({ ...prev, hazard: 'offline' }));
        }

        try {
          const anomalyRes = await fetch(`${apiBaseUrl}/api/anomaly/phantom-current/`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              current: rawCurrent,
              pir: rawPir,
              hour_of_day: new Date().getHours(),
              sample_window_minutes: 1
            })
          });
          if (anomalyRes.ok) {
            setAnomalyResult(await anomalyRes.json());
            setApiStatus(prev => ({ ...prev, anomaly: 'live' }));
          } else if (anomalyRes.status === 503) {
            setApiStatus(prev => ({ ...prev, anomaly: 'model pending' }));
          } else {
            setApiStatus(prev => ({ ...prev, anomaly: 'offline' }));
          }
        } catch (anomalyErr) {
          console.error("Error fetching anomaly prediction:", anomalyErr);
          setApiStatus(prev => ({ ...prev, anomaly: 'offline' }));
        }

        // Handle physical overcurrent relay trip in UI
        if (data.status === 'OVERCURRENT_TRIP') {
          setZones(prev => prev.map(z => z.id === 'kitchen-app' ? { ...z, active: false, status: 'Idle' } : z));
        }
      } catch (err) {
        console.error("Error fetching live telemetry:", err);
      }
    };

    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 600);
    return () => clearInterval(interval);
  }, [token, meshId, gatewayMac]);

  const handleToggleSecurityLock = async (nextLockedState: boolean) => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(`${apiUrl}/api/devices/toggle-lock/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ is_locked: nextLockedState })
      });
      if (res.ok) {
        const data = await res.json();
        setIsSecurityLocked(data.is_security_locked);

        const saved = localStorage.getItem('aether_user');
        if (saved) {
          const userObj = JSON.parse(saved);
          userObj.is_security_locked = data.is_security_locked;
          localStorage.setItem('aether_user', JSON.stringify(userObj));
        }

        addToast(
          `Mesh security set to ${data.is_security_locked ? 'PROTECTED' : 'UNLOCKED'}`,
          data.is_security_locked ? ShieldAlert : Globe
        );
      } else {
        const errData = await res.json();
        addToast(errData.error || "Failed to update security lock state", ShieldAlert);
      }
    } catch (err) {
      console.error("Error toggling security lock:", err);
      addToast("Network error updating lock state", ShieldAlert);
    }
  };

  const handleResetSafety = async () => {
    let currentGatewayMac = gatewayMac;
    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (!currentGatewayMac) {
      try {
        const devRes = await fetch(`${apiUrl}/api/devices/`, { headers });
        if (devRes.ok) {
          const devData = await devRes.json();
          // Look for either a gateway or a relay device acting as the central controller
          const gw = devData.devices.find((d: any) => d.role === 'gateway' || d.role === 'relay');
          if (gw) {
            currentGatewayMac = gw.mac_address;
            setGatewayMac(gw.mac_address);
          }
        }
      } catch (devErr) {
        console.error("Failed to fetch devices dynamically:", devErr);
      }
    }

    if (!currentGatewayMac) {
      addToast("No Central Gateway registered to reset.", ShieldAlert);
      return;
    }
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      addToast("Transmitting safety reset protocols...", Cpu);
      const res = await fetch(`${apiUrl}/api/devices/reset-safety/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mac_address: currentGatewayMac })
      });
      if (res.ok) {
        addToast("Relay re-engaged. System safety cleared!", Zap);
        setSystemStatus('SAFE');
        setShowOverlay(null);
        setResetCompleted(true);
      } else {
        const errData = await res.json();
        addToast(errData.error || "Reset command failed.", ShieldAlert);
      }
    } catch (err) {
      console.error("Failed to reset mesh safety:", err);
      addToast("Network connection error.", ShieldAlert);
    }
  };

  useEffect(() => {
    if (!showOverlay) {
      setIsMuted(false);
    }
  }, [showOverlay]);

  const [alertedMacs, setAlertedMacs] = useState<string[]>([]);

  useEffect(() => {
    const checkUnlinkedDevices = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8000';
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(`${apiUrl}/api/devices/unlinked/`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        const devices = data.devices || [];

        devices.forEach((dev: any) => {
          if (!alertedMacs.includes(dev.mac_address)) {
            addToast(`New device detected: ${dev.mac_address}. Go to Settings to register!`, Globe);
            setAlertedMacs(prev => [...prev, dev.mac_address]);
          }
        });
      } catch (err) {
        console.error("Error polling discovered devices:", err);
      }
    };

    checkUnlinkedDevices();
    const interval = setInterval(checkUnlinkedDevices, 5000);
    return () => clearInterval(interval);
  }, [alertedMacs, token]);

  return (
    <div className="flex min-h-dvh bg-bg-base relative md:flex-row flex-col safe-top">
      <div className="fixed inset-x-4 bottom-24 md:inset-x-auto md:bottom-8 md:right-8 z-[110] space-y-3 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
              className="bg-white border border-olive/10 rounded-2xl p-4 shadow-xl soft-shadow w-full md:min-w-[280px] md:w-auto flex items-center gap-4 pointer-events-auto overflow-hidden relative group/toast"
            >
              <div className="absolute top-0 left-0 w-1 h-full bg-olive animate-pulse" />
              <div className="p-2 rounded-xl bg-sage/10 text-olive">
                <toast.icon size={18} />
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-black uppercase text-ink/30 tracking-widest mb-0.5">Command Dispatched</p>
                <p className="text-xs font-bold text-ink italic">{toast.message}</p>
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="p-1 hover:bg-bg-card rounded-lg text-ink/20 hover:text-ink transition-colors"
                title="Dismiss"
              >
                <Power size={14} className="rotate-45" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <Sidebar
        activeView={activeView}
        setActiveView={setActiveView}
        zonesCount={zones.length}
        alertActive={!!showOverlay}
        setZones={setZones}
        addToast={addToast}
        metrics={systemMetrics}
        isEcoMode={isEcoMode}
        setIsEcoMode={setIsEcoMode}
        isSyncing={isSyncing}
        setIsSyncing={setIsSyncing}
        isAuthenticated={isAuthenticated}
        username={username}
      />

      <main className="flex-1 w-full min-w-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-6 lg:p-8 2xl:p-10 pb-32 md:pb-10">
        <AnimatePresence>
          {showOverlay && (
            <SafetyAlertOverlay
              type={showOverlay}
              onDismiss={() => {
                setIsMuted(true);
                setShowOverlay(null);
                setIsFlame(false);
                setGasLevel(120);
                addToast("Safety alert acknowledged", ShieldAlert);
              }}
              message={showOverlay === 'fire'
                ? "IR Sensors detected primary flame source in Zone 4 (Kitchen). Solenoid valve #01 has been locked and kitchen HVAC initialized at max capacity."
                : `LPG concentration has reached ${gasLevel.toFixed(0)}ppm. This exceeds the 300ppm safety threshold. All secondary electrical nodes have been isolated.`
              }
            />
          )}

          {selectedZone && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-ink/20 backdrop-blur-sm"
              onClick={() => setSelectedZone(null)}
            >
              <motion.div
                initial={{ scale: 0.95, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                className="max-w-4xl w-full bg-white rounded-[1.75rem] sm:rounded-[3rem] lg:rounded-[4rem] p-4 sm:p-8 md:p-12 shadow-2xl relative border border-olive/10 max-h-[92vh] overflow-y-auto no-scrollbar"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-5 mb-8 sm:mb-12">
                  <div className="flex items-center gap-4 sm:gap-6 min-w-0">
                    <div className={cn("p-4 sm:p-6 rounded-2xl sm:rounded-3xl bg-bg-card shadow-sm relative group shrink-0", selectedZone.color)}>
                      <selectedZone.icon size={28} />
                      {selectedZone.active && isEcoMode && (
                        <motion.div
                          animate={{ scale: [1, 1.2, 1] }}
                          transition={{ repeat: Infinity, duration: 2 }}
                          className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-sage flex items-center justify-center border-4 border-white"
                        >
                          <Wind size={10} className="text-white" />
                        </motion.div>
                      )}
                    </div>
                    <div>
                      <h2 className="text-2xl sm:text-3xl font-display font-medium text-ink leading-tight sm:leading-none mb-2">{selectedZone.name}</h2>
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1">
                        <p className="text-[10px] font-bold text-ink/30 uppercase tracking-wider sm:tracking-[0.2em]">{selectedZone.type}</p>
                        <span className="w-1 h-1 rounded-full bg-ink/20" />
                        <p className={cn(
                          "text-[10px] font-bold uppercase tracking-[0.2em]",
                          selectedZone.active ? "text-sage" : "text-ink/30"
                        )}>{selectedZone.status}</p>
                        {selectedZone.active && isEcoMode && (
                          <>
                            <span className="w-1 h-1 rounded-full bg-sage/20" />
                            <p className="text-[10px] font-bold text-sage uppercase tracking-[0.2em]">Efficiency Protocol 01</p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => toggleZone(selectedZone.id)}
                    className={cn(
                      "w-full sm:w-auto group relative overflow-hidden px-6 sm:px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all",
                      selectedZone.active ? "bg-olive text-white shadow-xl shadow-olive/10" : "bg-bg-card text-ink/40"
                    )}
                  >
                    <span className="relative z-10">{selectedZone.active ? 'Isolate Node' : 'Initialize Node'}</span>
                    {selectedZone.active && (
                      <motion.div
                        initial={{ x: '-100%' }}
                        animate={{ x: '100%' }}
                        transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                        className="absolute inset-0 bg-white/10 skew-x-12"
                      />
                    )}
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 sm:gap-12">
                  <div className="space-y-8">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
                      <h4 className="text-[10px] font-black uppercase text-ink/20 tracking-widest">Thermal Load Profile</h4>
                      <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
                        <button
                          onClick={() => setIsComparing(!isComparing)}
                          className={cn(
                            "flex items-center gap-2 px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest transition-all",
                            isComparing ? "bg-olive text-white shadow-md shadow-olive/10" : "bg-bg-card/50 text-ink/30 hover:text-ink"
                          )}
                        >
                          <Activity size={10} />
                          {isComparing ? 'Comparing' : 'Compare'}
                        </button>
                        <div className="flex gap-2 bg-bg-card/50 p-1 rounded-full shrink-0">
                          {['Daily', 'Weekly', 'Monthly'].map(r => (
                            <button
                              key={r}
                              onClick={() => {
                                setZoneRange(r);
                                setData(generateChartData(r));
                              }}
                              className={cn(
                                "px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest transition-all",
                                zoneRange === r ? "bg-white text-olive shadow-sm" : "text-ink/30 hover:text-ink"
                              )}
                            >
                              {r}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="h-56 sm:h-64 w-full bg-bg-card/10 rounded-[1.75rem] sm:rounded-[3rem] p-3 sm:p-8 relative overflow-hidden border border-olive/5">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data}>
                          <defs>
                            <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#2D4C3B" stopOpacity={0.2} />
                              <stop offset="95%" stopColor="#2D4C3B" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="colorPrev" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#D9D9D9" stopOpacity={0.1} />
                              <stop offset="95%" stopColor="#D9D9D9" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#31332908" />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                return (
                                  <div className="bg-white p-4 rounded-2xl shadow-xl border border-olive/10 flex flex-col gap-1">
                                    <p className="text-[10px] font-black text-ink/30 uppercase tracking-widest mb-1">{payload[0].payload.name}</p>
                                    <div className="flex items-center gap-2">
                                      <div className="w-1.5 h-1.5 rounded-full bg-olive" />
                                      <p className="text-xs font-bold text-ink">Current: {Number(payload[0].value ?? 0).toFixed(0)}W</p>
                                    </div>
                                    {isComparing && payload[1] && (
                                      <div className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-ink/10" />
                                        <p className="text-xs font-bold text-ink/40">Previous: {Number(payload[1].value ?? 0).toFixed(0)}W</p>
                                      </div>
                                    )}
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey="value"
                            stroke="#2D4C3B"
                            strokeWidth={3}
                            fillOpacity={1}
                            fill="url(#colorVal)"
                            animationDuration={1500}
                          />
                          {isComparing && (
                            <Area
                              type="monotone"
                              dataKey="previous"
                              stroke="#D9D9D9"
                              strokeWidth={2}
                              strokeDasharray="5 5"
                              fillOpacity={1}
                              fill="url(#colorPrev)"
                              animationDuration={1500}
                            />
                          )}
                        </AreaChart>
                      </ResponsiveContainer>
                      <div className="absolute top-4 left-8 pointer-events-none">
                        <span className="text-[9px] font-black text-ink/10 uppercase tracking-[0.2em]">Live Topology Trace</span>
                      </div>
                    </div>
                    <div className="mt-6 flex justify-between">
                      <div>
                        <div className="text-[8px] font-black text-ink/20 uppercase tracking-widest">Range Average</div>
                        <div className="text-lg font-display font-medium text-olive">{selectedZone.dailyAvg}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[8px] font-black text-ink/20 uppercase tracking-widest">Sync Integrity</div>
                        <div className="text-lg font-display font-medium text-sage">Perfect</div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-8 border-t lg:border-t-0 lg:border-l border-olive/5 pt-8 sm:pt-12 lg:pt-0 lg:pl-12">
                    <div className="space-y-6">
                      <div className="flex justify-between items-center">
                        <h4 className="text-[10px] font-black uppercase text-ink/20 tracking-widest">Applied Logic Rules</h4>
                        <button
                          onClick={() => setShowRuleBuilder(!showRuleBuilder)}
                          className="p-2 rounded-xl bg-bg-card hover:bg-olive hover:text-white transition-all text-ink/40"
                        >
                          {showRuleBuilder ? <X size={14} /> : <Plus size={14} />}
                        </button>
                      </div>

                      <AnimatePresence>
                        {showRuleBuilder && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="p-4 sm:p-6 bg-bg-card/50 rounded-[1.75rem] sm:rounded-[2.5rem] border border-olive/10 space-y-4 overflow-hidden"
                          >
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-center">
                              <div>
                                <label className="text-[8px] font-black uppercase text-ink/30 mb-2 block tracking-widest">When</label>
                                <div className="flex flex-wrap gap-2 justify-center">
                                  {['Time', 'Motion', 'Temp'].map(c => (
                                    <button
                                      key={c}
                                      onClick={() => setNewRule({ ...newRule, condition: c })}
                                      className={cn(
                                        "px-3 py-1.5 rounded-full text-[9px] font-bold transition-all border",
                                        newRule.condition === c ? "bg-olive text-white border-olive" : "bg-white text-ink/30 border-olive/5"
                                      )}
                                    >
                                      {c}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <label className="text-[8px] font-black uppercase text-ink/30 mb-2 block tracking-widest">Action</label>
                                <div className="flex flex-wrap gap-2 justify-center">
                                  {['On', 'Off', 'Dim'].map(a => (
                                    <button
                                      key={a}
                                      onClick={() => setNewRule({ ...newRule, action: a })}
                                      className={cn(
                                        "px-3 py-1.5 rounded-full text-[9px] font-bold transition-all border",
                                        newRule.action === a ? "bg-olive text-white border-olive" : "bg-white text-ink/30 border-olive/5"
                                      )}
                                    >
                                      {a}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <button
                              onClick={addAutomationRule}
                              className="w-full py-3 bg-ink text-white rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all hover:bg-olive"
                            >
                              Deploy Logic Rule
                            </button>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <div className="space-y-3">
                        {selectedZone.rules.map((rule: any, i: number) => (
                          <div key={i} className="p-4 bg-bg-base border border-olive/5 rounded-2xl text-[11px] font-bold text-ink/70 flex items-center justify-between gap-3 italic">
                            <div className="flex items-center gap-4">
                              <div className={cn("w-1.5 h-1.5 rounded-full transition-colors", rule.active ? "bg-sage" : "bg-ink/10")} />
                              {rule.text}
                            </div>
                            <button
                              onClick={() => {
                                const updatedRules = selectedZone.rules.filter((_: any, idx: number) => idx !== i);
                                setZones(prev => prev.map(z => z.id === selectedZone.id ? { ...z, rules: updatedRules } : z));
                                setSelectedZone({ ...selectedZone, rules: updatedRules });
                                addToast("Rule purged from mesh", AlertTriangle);
                              }}
                              className="text-ink/10 hover:text-danger p-1 transition-all"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {activeView === 'dashboard' && (
            <DashboardView
              data={data}
              metrics={systemMetrics}
              zones={zones}
              onZoneSelect={(zone) => {
                setSelectedZone(zone);
                setActiveView('zones');
              }}
              isSecurityLocked={isSecurityLocked}
              setIsSecurityLocked={handleToggleSecurityLock}
              onGoToSafety={() => setActiveView('safety')}
              liveTelemetry={liveTelemetry}
              sensorData={sensorData}
              hazardRisk={hazardRisk}
              anomalyResult={anomalyResult}
              energyRecommendations={energyRecommendations}
              apiStatus={apiStatus}
            />
          )}

          {activeView === 'zones' && (
            <motion.div
              key="zones"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              className="space-y-8 sm:space-y-12 pb-20"
            >
              <div>
                <h2 className="text-2xl sm:text-3xl font-display font-medium text-olive mb-2 italic">Energy Topology</h2>
                <p className="text-[10px] text-ink/30 font-black uppercase tracking-wider sm:tracking-[0.3em] mb-6 sm:mb-10">Spatial load mapping across the mesh</p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                  {zones.map((zone) => (
                    <div
                      key={zone.id}
                      onClick={() => setSelectedZone(zone)}
                      className={cn(
                        "p-5 sm:p-8 rounded-[1.75rem] sm:rounded-[3.5rem] border transition-all cursor-pointer flex flex-col justify-between group h-56 sm:h-64",
                        zone.active ? "bg-white border-olive/10 soft-shadow" : "bg-bg-card/30 border-transparent opacity-60"
                      )}
                    >
                      <div className="flex justify-between items-start">
                        <div className={cn("p-5 rounded-2xl bg-bg-card/50 shadow-sm transition-transform group-hover:scale-110", zone.active ? zone.color : "text-ink/20")}>
                          <zone.icon size={28} />
                        </div>
                        <div
                          onClick={(e) => toggleZone(zone.id, e)}
                          className={cn(
                            "w-12 h-6 rounded-full flex items-center px-1 transition-colors",
                            zone.active ? "bg-olive/10" : "bg-ink/5"
                          )}
                        >
                          <motion.div
                            animate={{ x: zone.active ? 24 : 0 }}
                            className={cn("w-4 h-4 rounded-full shadow-md", zone.active ? "bg-olive" : "bg-ink/20")}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="text-[10px] text-ink/50 font-black tracking-[0.2em] uppercase flex items-center gap-2 mb-1">
                          {zone.name}
                          <span className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            zone.status === 'Active' ? "bg-sage animate-pulse" :
                              zone.status === 'Standby' ? "bg-clay" : "bg-ink/10"
                          )} />
                        </div>
                        <div className="text-2xl font-display font-medium text-ink flex items-baseline gap-2">
                          {zone.active ? `${zone.nominalConsumption}W` : zone.status}
                          <span className="text-[10px] text-ink/30 font-black uppercase tracking-widest">{zone.type}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {activeView === 'analytics' && (
            <AnalyticsView
              data={sensorData.length ? sensorData : data}
              zones={zones}
              metrics={systemMetrics}
              activeRange={analyticsRange}
              onRangeChange={(range) => {
                setAnalyticsRange(range);
                setData(generateChartData(range));
              }}
              onDetailedMap={() => setActiveView('zones')}
              insight={energyInsight}
              isLoading={isInsightLoading}
              onRefresh={fetchEnergyInsights}
            />
          )}

          {activeView === 'automation' && (
            <AutomationView
              zones={zones}
              addToast={addToast}
              onToggleRule={toggleRule}
              onNewMacro={() => {
                setSelectedZone(zones[0]);
                setShowRuleBuilder(true);
                addToast("Macro drafting system initialized", Plus);
              }}
              onGlobalTrigger={() => {
                setSelectedZone(zones[0]);
                setShowRuleBuilder(true);
                addToast("Global trigger matrix mapping initiated", Globe);
              }}
              onAiOptimize={fetchAiSuggestions}
              isLoading={isAiLoading}
              suggestions={aiSuggestions}
              onDeployAiRule={(text) => {
                const ruleObj = { text, active: true };
                setZones(prev => prev.map(z => z.id === zones[0].id ? { ...z, rules: [...z.rules, ruleObj] } : z));
                addToast("AI Protocol deployed to Living Room", Zap);
                setAiSuggestions(prev => prev.filter(s => s.text !== text));
              }}
            />
          )}

          {activeView === 'room-architect' && (
            <Suspense fallback={
              <div className="min-h-[420px] rounded-[2.5rem] bg-white border border-olive/10 flex items-center justify-center text-sm font-bold text-olive">
                Loading room architect...
              </div>
            }>
              <RoomArchitectView
                zones={zones}
                onToggleZone={toggleZone}
                addToast={addToast}
              />
            </Suspense>
          )}

          {activeView === 'controls' && (
            <ManualControlView zones={zones} toggleZone={toggleZone} setZones={setZones} addToast={addToast} />
          )}

          {activeView === 'safety' && (
            <SafetyHubView
              gasLevel={gasLevel}
              isFlame={isFlame}
              systemStatus={systemStatus}
              onResetSafety={handleResetSafety}
              resetCompleted={resetCompleted}
              isSecurityLocked={isSecurityLocked}
              setIsSecurityLocked={handleToggleSecurityLock}
            />
          )}

          {activeView === 'events' && (
            <EventsView />
          )}

          {activeView === 'settings' && (
            <SettingsView
              isAuthenticated={isAuthenticated}
              setIsAuthenticated={setIsAuthenticated}
              username={username}
              setUsername={setUsername}
              meshId={meshId}
              setMeshId={setMeshId}
              meshKey={meshKey}
              setMeshKey={setMeshKey}
              token={token}
              setToken={setToken}
            />
          )}
        </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
