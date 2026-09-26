import React from 'react';
import { motion } from 'motion/react';
import { TrendingUp, Cpu, Zap, Plus, Activity } from 'lucide-react';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';
import { EnergyInsight } from '../services/geminiService';
import { cn } from '../lib/utils';

interface AnalyticsViewProps {
  data: any;
  zones: any[];
  metrics: any;
  activeRange: string;
  onRangeChange: (r: string) => void;
  onDetailedMap: () => void;
  insight: EnergyInsight | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export const AnalyticsView = ({ 
  data, 
  zones, 
  metrics, 
  activeRange, 
  onRangeChange,
  onDetailedMap,
  insight,
  isLoading,
  onRefresh
}: AnalyticsViewProps) => {
  const chartData = Array.isArray(data)
    ? data.map((point: any, index: number) => {
      const power = Number(point.Power ?? point.power ?? point.value ?? 0);
      const previousPoint = data[index - 1] as any;
      const previousPower = Number(previousPoint?.Power ?? previousPoint?.power ?? previousPoint?.value ?? power);
      return {
        ...point,
        name: point.name || point.timestamp || `${index + 1}`,
        Power: Number.isFinite(power) ? power : 0,
        previousPower: Number.isFinite(previousPower) ? previousPower : 0,
      };
    })
    : [];
  const latestPower = chartData.length ? chartData[chartData.length - 1].Power : 0;

  return (
  <motion.div 
    initial={{ opacity: 0, scale: 0.98 }}
    animate={{ opacity: 1, scale: 1 }}
    className="space-y-8 2xl:space-y-10 pb-20"
  >
    <div className="flex flex-col xl:flex-row xl:justify-between xl:items-end gap-5">
      <div>
        <h2 className="text-2xl sm:text-4xl font-display font-medium text-ink leading-tight sm:leading-none mb-3">Mesh Analytics</h2>
        <p className="text-[10px] text-ink/30 font-black uppercase tracking-[0.3em]">Advanced topological load research</p>
      </div>
      <div className="flex items-center gap-3 overflow-x-auto no-scrollbar">
        {isLoading && (
          <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}>
            <Cpu size={16} className="text-olive" />
          </motion.div>
        )}
        <div className="flex gap-2 p-1.5 bg-bg-card rounded-[2rem] border border-olive/5 overflow-x-auto no-scrollbar">
          {['Live', 'Day', 'Week', 'Month', 'Year'].map(t => (
            <button 
              key={t} 
              onClick={() => onRangeChange(t)}
              className={cn(
                "px-4 sm:px-6 py-2.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all shrink-0", 
                activeRange === t ? "bg-white text-olive shadow-sm" : "text-ink/30 hover:text-ink"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
    </div>

    <div className="grid grid-cols-1 2xl:grid-cols-3 gap-6 2xl:gap-8">
      <div className="2xl:col-span-2 bg-white rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] p-4 sm:p-6 xl:p-8 2xl:p-12 border border-olive/10 soft-shadow">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6 sm:mb-10">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-sage/10 rounded-2xl">
              <TrendingUp size={24} className="text-olive" />
            </div>
            <div>
               <h3 className="text-sm font-bold text-ink uppercase tracking-widest">Power Usage Map</h3>
               <p className="text-[9px] text-ink/20 font-black uppercase mt-0.5 tracking-widest">Live dataset Power column</p>
            </div>
          </div>
          <div className="text-left sm:text-right">
             <div className="text-[8px] font-black text-ink/20 uppercase tracking-widest">Latest Power</div>
             <div className="text-xl font-display font-medium text-olive">{latestPower.toFixed(1)} <span className="text-xs opacity-40">W</span></div>
          </div>
        </div>
        <div className="h-[260px] sm:h-[320px] 2xl:h-96">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="analysisGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#606C38" stopOpacity={0.15}/>
                  <stop offset="95%" stopColor="#606C38" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#606C3810" />
              <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 900, fill: 'rgba(96,108,56,0.3)' }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 900, fill: 'rgba(96,108,56,0.3)' }} />
              <Tooltip 
                contentStyle={{ borderRadius: '32px', border: 'none', boxShadow: '0 20px 50px rgba(45,76,59,0.1)', padding: '20px' }}
                itemStyle={{ color: '#2D4C3B', fontWeight: 900, fontSize: '12px' }}
                formatter={(value: any, name: any) => [`${Number(value || 0).toFixed(1)} W`, name === 'Power' ? 'Power' : 'Previous']}
              />
              <Area type="monotone" dataKey="Power" stroke="#606C38" fillOpacity={1} fill="url(#analysisGrad)" strokeWidth={5} />
              <Area type="monotone" dataKey="previousPower" stroke="#D9D9D9" fillOpacity={0} strokeWidth={2} strokeDasharray="10 10" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="space-y-8">
        <div className="bg-bg-card/40 rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[3.5rem] p-4 sm:p-6 xl:p-8 2xl:p-10 border border-olive/10 h-full min-h-[280px] sm:min-h-[320px] flex flex-col items-center justify-center text-center relative overflow-hidden">
           {isLoading && (
             <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-20 flex flex-col items-center justify-center">
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 3, ease: "linear" }}>
                  <Cpu size={40} className="text-olive" />
                </motion.div>
                <p className="mt-4 text-[10px] font-black uppercase tracking-widest text-olive">AI Synthesizing...</p>
             </div>
           )}
           
           {!insight && !isLoading ? (
             <div className="flex flex-col items-center">
                <div className="w-16 h-16 bg-olive/5 rounded-full flex items-center justify-center mb-6">
                  <Activity size={24} className="text-olive" />
                </div>
                <h4 className="text-lg font-display font-medium text-ink mb-2 italic">No Insights Yet</h4>
                <p className="text-[11px] text-ink/40 italic px-6 mb-6">Start analysis to get AI-powered recommendations.</p>
                <button 
                  onClick={onRefresh}
                  className="px-8 py-3 bg-olive text-white rounded-full text-[9px] font-black uppercase tracking-widest shadow-lg shadow-olive/10 transition-all hover:scale-105"
                >
                  Analyze System
                </button>
             </div>
           ) : (
             <motion.div 
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               className="h-full flex flex-col"
             >
                <div className="w-12 h-12 bg-olive rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-olive/20 mx-auto">
                  <Zap size={20} className="text-white" />
                </div>
                <h4 className="text-lg font-display font-medium text-ink mb-2 italic">Gemini Insights</h4>
                <div className="text-[10px] text-ink/50 italic leading-relaxed text-left mb-6 bg-white/40 p-4 rounded-2xl border border-olive/5">
                  {insight?.analysis}
                </div>
                <div className="space-y-3 text-left">
                  {insight?.recommendations.map((rec, i) => (
                    <div key={i} className="flex gap-3">
                      <div className="w-4 h-4 rounded-full bg-olive/10 flex items-center justify-center shrink-0 mt-0.5">
                        <Plus size={8} className="text-olive" />
                      </div>
                      <p className="text-[9px] font-bold text-ink/60 italic">{rec}</p>
                    </div>
                  ))}
                </div>
                <button 
                   onClick={onRefresh}
                   className="mt-auto px-8 py-3 text-olive border border-olive/10 rounded-full text-[9px] font-black uppercase tracking-widest transition-all hover:bg-olive/5"
                >
                   Refresh Analysis
                </button>
             </motion.div>
           )}
        </div>
      </div>
    </div>
  </motion.div>
  );
};
