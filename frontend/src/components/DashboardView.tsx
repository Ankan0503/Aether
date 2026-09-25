import React from 'react';
import { motion } from 'motion/react';
import { 
  Zap, 
  Cpu, 
  DollarSign, 
  ShieldAlert,
  BrainCircuit,
  AlertTriangle,
  TrendingUp,
  Gauge,
  Activity,
  Flame,
  Bell,
  IndianRupee,
  PlugZap,
  ArrowUpRight
} from 'lucide-react';
import { 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  ComposedChart,
  Line,
  BarChart,
  Bar,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis
} from 'recharts';
import { cn } from '../lib/utils';

interface DashboardViewProps {
  data: any;
  metrics: any;
  zones: any[];
  onZoneSelect: (z: any) => void;
  onGoToSafety: () => void;
  liveTelemetry?: any;
  sensorData?: any[];
  hazardRisk?: any;
  anomalyResult?: any;
  energyRecommendations?: any;
  apiStatus?: {
    hazard: string;
    anomaly: string;
    recommendations: string;
  };
  isSecurityLocked?: boolean;
  setIsSecurityLocked?: (v: boolean) => void;
}

export const DashboardView = ({ 
  data, 
  metrics, 
  zones, 
  onZoneSelect,
  onGoToSafety,
  liveTelemetry,
  sensorData = [],
  hazardRisk,
  anomalyResult,
  energyRecommendations,
  apiStatus,
  isSecurityLocked,
  setIsSecurityLocked
}: DashboardViewProps) => {
  const riskScore = Number(hazardRisk?.risk_score ?? 0);
  const riskCritical = riskScore >= 75;
  const recommendationList = energyRecommendations?.recommendations ?? [];
  const estimatedSavings = Number(energyRecommendations?.summary?.estimated_monthly_savings ?? 0);
  const activeAlerts = [
    ...(anomalyResult?.anomaly ? [{
      title: anomalyResult.anomaly_type || 'Energy anomaly',
      message: `Confidence ${(Number(anomalyResult.confidence_score ?? 0) * 100).toFixed(0)}%. Estimated waste ${Number(anomalyResult.estimated_energy_waste?.estimated_waste_wh ?? 0).toFixed(4)} Wh.`,
      tone: 'amber'
    }] : []),
    ...(hazardRisk?.hazard_detected ? [{
      title: hazardRisk.hazard_type,
      message: hazardRisk.explanation,
      tone: riskCritical ? 'red' : 'amber'
    }] : []),
  ];

  const chartData = sensorData.length ? sensorData : data.map((point: any) => ({
    ...point,
    current: point.value,
    gas: 0,
    risk: 0,
  }));

  const cardBase = "bg-white border border-olive/10 rounded-[1.5rem] sm:rounded-3xl shadow-sm";

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5 sm:space-y-6 2xl:space-y-8 pb-20"
    >
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-6">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-olive/5 border border-olive/10 text-olive text-[10px] font-black uppercase tracking-widest mb-4">
            <Activity size={14} className="animate-pulse" />
            AI Energy Operations
          </div>
          <h2 className="text-2xl sm:text-3xl md:text-5xl font-display font-semibold text-ink leading-tight">Smart Home Energy Command Center</h2>
          <p className="text-sm text-ink/50 mt-3 max-w-3xl">Live sensor telemetry, predictive safety scoring, anomaly detection and savings recommendations from the Django AI services.</p>
        </div>
        <button 
          onClick={onGoToSafety}
          className={cn(
            "w-full sm:w-auto px-5 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3 self-start xl:self-auto",
            riskCritical ? "bg-danger text-white shadow-xl shadow-danger/20 animate-pulse" : "bg-ink text-white hover:bg-olive"
          )}
        >
          <ShieldAlert size={16} />
          Safety Center
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-4">
        {[
          { label: 'Current Load', value: `${metrics.totalLoad} kW`, icon: Zap, sub: `${liveTelemetry?.current ?? 0}A live feed`, tone: 'olive' },
          { label: 'AI Insights', value: recommendationList.length, icon: BrainCircuit, sub: apiStatus?.recommendations || 'ready', tone: 'sage' },
          { label: 'Anomaly Alerts', value: activeAlerts.length, icon: AlertTriangle, sub: apiStatus?.anomaly || 'monitoring', tone: activeAlerts.length ? 'danger' : 'sage' },
          { label: 'Risk Score', value: riskScore, icon: Gauge, sub: hazardRisk?.severity || 'low', tone: riskCritical ? 'danger' : 'olive' },
          { label: 'Monthly Savings', value: `₹${estimatedSavings.toFixed(0)}`, icon: IndianRupee, sub: 'estimated by engine', tone: 'clay' },
        ].map((item) => (
          <div key={item.label} className={`${cardBase} p-4 sm:p-5 min-h-[132px] sm:min-h-[144px]`}>
            <div className="flex items-start justify-between gap-3">
              <div className={cn(
                "w-11 h-11 rounded-2xl flex items-center justify-center",
                item.tone === 'danger' ? "bg-danger/10 text-danger" :
                item.tone === 'clay' ? "bg-clay/15 text-clay" :
                item.tone === 'sage' ? "bg-sage/15 text-sage" : "bg-olive/10 text-olive"
              )}>
                <item.icon size={20} />
              </div>
              <ArrowUpRight size={16} className="text-ink/20" />
            </div>
            <div className="mt-5">
              <p className="text-[10px] font-black uppercase tracking-widest text-ink/35">{item.label}</p>
              <div className="text-2xl sm:text-3xl font-display font-semibold text-ink mt-1">{item.value}</div>
              <p className="text-[11px] text-ink/45 mt-1 capitalize">{item.sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-3 gap-6">
        <div className={`${cardBase} 2xl:col-span-2 p-4 sm:p-6 md:p-8`}>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-ink">Real-Time Sensor Visualization</h3>
              <p className="text-xs text-ink/40 mt-1">Current, MQ2 gas and computed risk score streamed from Django APIs.</p>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-sage/10 text-sage text-[10px] font-black uppercase tracking-widest">
              <span className="w-2 h-2 rounded-full bg-sage animate-pulse" />
              Live
            </div>
          </div>
          <div className="h-[260px] sm:h-[320px] 2xl:h-[360px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <defs>
                  <linearGradient id="loadGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#606C38" stopOpacity={0.18}/>
                    <stop offset="95%" stopColor="#606C38" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="gasGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#bc4749" stopOpacity={0.16}/>
                    <stop offset="95%" stopColor="#bc4749" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3E423A12" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'rgba(62,66,58,0.38)' }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'rgba(62,66,58,0.38)' }} />
                <Tooltip contentStyle={{ borderRadius: 18, border: '1px solid rgba(96,108,56,0.12)', boxShadow: '0 18px 50px rgba(62,66,58,0.12)' }} />
                <Area type="monotone" dataKey="current" name="Current A" stroke="#606C38" fill="url(#loadGradient)" strokeWidth={3} />
                <Area type="monotone" dataKey="gas" name="MQ2 Gas" stroke="#bc4749" fill="url(#gasGradient)" strokeWidth={2} />
                <Line type="monotone" dataKey="risk" name="Risk Score" stroke="#D4A373" strokeWidth={3} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className={cn(
          `${cardBase} p-4 sm:p-6 md:p-8 relative overflow-hidden`,
          riskCritical && "border-danger/40 shadow-danger/10 hazard-warning"
        )}>
          <div className={cn("absolute inset-x-0 top-0 h-1", riskCritical ? "bg-danger" : "bg-olive")} />
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-ink">Hazard Risk Score</h3>
              <p className="text-xs text-ink/40 mt-1">{hazardRisk?.hazard_type || 'NORMAL'}</p>
            </div>
            <div className={cn("p-3 rounded-2xl", riskCritical ? "bg-danger text-white animate-bounce" : "bg-olive/10 text-olive")}>
              {hazardRisk?.hazard_type?.includes('FIRE') ? <Flame size={22} /> : <ShieldAlert size={22} />}
            </div>
          </div>
          <div className="h-48 sm:h-56">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart innerRadius="72%" outerRadius="100%" data={[{ name: 'Risk', value: riskScore, fill: riskCritical ? '#bc4749' : '#606C38' }]} startAngle={180} endAngle={-180}>
                <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                <RadialBar dataKey="value" cornerRadius={18} background={{ fill: 'rgba(62,66,58,0.08)' }} />
              </RadialBarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-center -mt-36 mb-16 pointer-events-none">
            <div className={cn("text-5xl sm:text-6xl font-display font-semibold", riskCritical ? "text-danger" : "text-olive")}>{riskScore}</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-ink/35">{hazardRisk?.severity || 'Low'} Risk</div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Buzzer', hazardRisk?.actions?.buzzer_alert],
              ['Valve', hazardRisk?.actions?.solenoid_valve_shutoff],
              ['Notify', hazardRisk?.actions?.dashboard_notification],
            ].map(([label, enabled]) => (
              <div key={String(label)} className={cn("p-3 rounded-2xl text-center border", enabled ? "bg-danger/5 border-danger/15 text-danger" : "bg-bg-card/30 border-olive/5 text-ink/35")}>
                <p className="text-[9px] font-black uppercase tracking-widest">{label}</p>
                <p className="text-xs font-bold mt-1">{enabled ? 'Armed' : 'Clear'}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6">
        <div className={`${cardBase} p-4 sm:p-6 md:p-8`}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-ink">AI Insights</h3>
              <p className="text-xs text-ink/40 mt-1">Top recommendations from the energy engine.</p>
            </div>
            <BrainCircuit size={22} className="text-olive" />
          </div>
          <div className="space-y-3">
            {recommendationList.slice(0, 3).length ? recommendationList.slice(0, 3).map((rec: any) => (
              <div key={rec.id} className="p-4 rounded-2xl bg-bg-card/35 border border-olive/5">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-sm font-bold text-ink">{rec.title}</h4>
                  <span className="text-[10px] font-black text-olive">₹{Number(rec.estimated_monthly_savings ?? 0).toFixed(0)}</span>
                </div>
                <p className="text-xs text-ink/50 mt-2 leading-relaxed">{rec.message}</p>
              </div>
            )) : (
              <div className="p-6 rounded-2xl bg-bg-card/30 text-center">
                <Cpu size={22} className="mx-auto text-ink/25 mb-3" />
                <p className="text-sm font-bold text-ink/50">Waiting for recommendation history.</p>
              </div>
            )}
          </div>
        </div>

        <div className={`${cardBase} p-4 sm:p-6 md:p-8`}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-ink">Anomaly Alerts</h3>
              <p className="text-xs text-ink/40 mt-1">Phantom current and safety warnings.</p>
            </div>
            <Bell size={22} className={activeAlerts.length ? "text-danger animate-pulse" : "text-olive"} />
          </div>
          <div className="space-y-3">
            {activeAlerts.length ? activeAlerts.map((alert, index) => (
              <div key={`${alert.title}-${index}`} className={cn("p-4 rounded-2xl border", alert.tone === 'red' ? "bg-danger/5 border-danger/20" : "bg-clay/10 border-clay/20")}>
                <div className="flex items-center gap-3">
                  <AlertTriangle size={18} className={alert.tone === 'red' ? "text-danger" : "text-clay"} />
                  <h4 className="text-sm font-bold text-ink">{alert.title}</h4>
                </div>
                <p className="text-xs text-ink/55 mt-2 leading-relaxed">{alert.message}</p>
              </div>
            )) : (
              <div className="p-6 rounded-2xl bg-sage/10 text-center">
                <ShieldAlert size={22} className="mx-auto text-sage mb-3" />
                <p className="text-sm font-bold text-ink">No active anomaly alerts.</p>
                <p className="text-xs text-ink/45 mt-1">{apiStatus?.anomaly || 'Monitoring live load signatures.'}</p>
              </div>
            )}
          </div>
        </div>

        <div className={`${cardBase} p-4 sm:p-6 md:p-8`}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-widest text-ink">Energy Trends</h3>
              <p className="text-xs text-ink/40 mt-1">Active zone load distribution.</p>
            </div>
            <TrendingUp size={22} className="text-olive" />
          </div>
          <div className="h-44 sm:h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={zones.map((zone) => ({ name: zone.name.split(' ')[0], watts: zone.active ? zone.nominalConsumption : Math.round(zone.nominalConsumption * 0.08) }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#3E423A10" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'rgba(62,66,58,0.45)', fontWeight: 700 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: 'rgba(62,66,58,0.35)', fontWeight: 700 }} />
                <Tooltip contentStyle={{ borderRadius: 16, border: '1px solid rgba(96,108,56,0.12)' }} />
                <Bar dataKey="watts" fill="#606C38" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="p-4 bg-bg-card/30 rounded-2xl">
              <DollarSign size={16} className="text-clay mb-2" />
              <p className="text-[9px] font-black uppercase tracking-widest text-ink/35">Daily Cost</p>
              <p className="text-xl font-display font-semibold text-ink">₹{metrics.dailySpend}</p>
            </div>
            <div className="p-4 bg-bg-card/30 rounded-2xl">
              <PlugZap size={16} className="text-olive mb-2" />
              <p className="text-[9px] font-black uppercase tracking-widest text-ink/35">Efficiency</p>
              <p className="text-xl font-display font-semibold text-ink">{metrics.efficiency}%</p>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
