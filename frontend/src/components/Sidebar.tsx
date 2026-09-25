import React from 'react';
import { motion } from 'motion/react';
import { 
  Cpu, 
  Zap, 
  ShieldAlert, 
  LayoutDashboard, 
  TrendingUp, 
  Power, 
  Bell, 
  Settings, 
  ChevronRight, 
  Wind, 
  Layers, 
  Activity,
  User,
  Box
} from 'lucide-react';
import { cn } from '../lib/utils';

interface SidebarProps {
  activeView: string;
  setActiveView: (v: string) => void;
  zonesCount: number;
  alertActive: boolean;
  setZones: React.Dispatch<React.SetStateAction<any[]>>;
  addToast: (message: string, icon: any) => void;
  metrics: any;
  isEcoMode: boolean;
  setIsEcoMode: (v: boolean) => void;
  isSyncing: boolean;
  setIsSyncing: (v: boolean) => void;
  isAuthenticated: boolean;
  username: string;
}

export const Sidebar = ({ 
  activeView, 
  setActiveView, 
  zonesCount, 
  alertActive, 
  setZones, 
  addToast,
  metrics,
  isEcoMode,
  setIsEcoMode,
  isSyncing,
  setIsSyncing,
  isAuthenticated,
  username
}: SidebarProps) => {
  const menuGroups = [
    {
      title: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'zones', label: 'Energy Zones', icon: Zap, badge: zonesCount },
        { id: 'analytics', label: 'Analytics', icon: TrendingUp },
        { id: 'room-architect', label: 'Room Architect', icon: Box },
      ],
    },
    {
      title: 'Operations',
      items: [
        { id: 'controls', label: 'Manual Control', icon: Power },
        { id: 'safety', label: 'Safety Hub', icon: ShieldAlert, alert: alertActive },
        { id: 'automation', label: 'Automation', icon: Cpu },
      ],
    },
    {
      title: 'System',
      items: [
        { id: 'events', label: 'System Events', icon: Bell },
        { id: 'settings', label: 'Configuration', icon: Settings },
      ],
    },
  ];

  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 h-auto bg-white/95 border-t border-olive/10 shadow-[0_-14px_40px_rgba(62,66,58,0.08)] backdrop-blur-xl md:sticky md:inset-x-auto md:bottom-auto md:top-0 md:w-[280px] 2xl:w-[304px] md:h-dvh md:bg-white md:border-t-0 md:border-r md:shadow-none flex flex-col overflow-hidden safe-bottom">
      <div className="hidden md:block px-6 pt-6 pb-5 border-b border-olive/5">
        <button
          onClick={() => setActiveView('dashboard')}
          className="flex w-full items-center gap-3 rounded-2xl text-left transition-colors hover:bg-bg-card/35"
        >
          <div className="w-11 h-11 rounded-2xl bg-olive flex items-center justify-center shadow-lg shadow-olive/10">
            <Cpu size={21} className="text-white" />
          </div>
          <div className="min-w-0">
            <span className="block font-display font-bold text-2xl text-ink leading-none tracking-normal">AETHER.</span>
            <span className="mt-1.5 block text-[9px] font-black uppercase text-olive tracking-[0.28em]">Mesh OS v2.4</span>
          </div>
        </button>
      </div>

      <nav className="flex gap-2 overflow-x-auto px-3 py-2 touch-pan-x no-scrollbar md:flex-1 md:block md:overflow-y-auto md:overflow-x-hidden md:px-4 md:py-5 md:space-y-6 custom-scrollbar">
        {menuGroups.map((group) => (
          <div key={group.title} className="contents md:block md:space-y-1.5">
            <div className="hidden md:block px-3 pb-1">
              <span className="text-[10px] font-black uppercase text-ink/25 tracking-[0.18em]">{group.title}</span>
            </div>
            {group.items.map((item) => {
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveView(item.id)}
                  className={cn(
                    "min-w-[78px] flex flex-col items-center justify-center gap-1.5 px-2 py-2.5 rounded-2xl transition-all group relative border md:min-w-0 md:w-full md:flex-row md:justify-between md:px-3 md:py-2.5 md:rounded-2xl",
                    isActive
                      ? "bg-olive text-white border-olive shadow-sm shadow-olive/10"
                      : "text-ink/45 border-transparent hover:bg-bg-card/40 hover:text-ink"
                  )}
                >
                  {isActive && (
                    <motion.div
                      layoutId="desktop-nav-active"
                      className="hidden md:block absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-white/80"
                    />
                  )}
                  <div className="flex flex-col items-center gap-1.5 md:flex-row md:gap-3">
                    <div
                      className={cn(
                        "h-8 w-8 rounded-xl flex items-center justify-center transition-colors",
                        isActive ? "bg-white/15 text-white" : "bg-transparent text-ink/35 group-hover:bg-white group-hover:text-olive"
                      )}
                    >
                      <item.icon size={17} />
                    </div>
                    <span className="max-w-[66px] truncate text-[9px] font-black uppercase tracking-normal leading-none md:max-w-[154px] md:text-[10px] md:tracking-[0.12em]">
                      {item.label}
                    </span>
                  </div>
                  <div className="absolute right-2 top-2 flex items-center gap-2 md:static">
                    {item.badge && (
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded-lg text-[8px] font-black",
                          isActive ? "bg-white/15 text-white" : "bg-olive/10 text-olive"
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                    {item.alert && (
                      <span className={cn("w-2 h-2 rounded-full animate-pulse", isActive ? "bg-white" : "bg-danger shadow-sm shadow-danger/20")} />
                    )}
                    <ChevronRight
                      size={14}
                      className={cn("hidden md:block transition-all", isActive ? "opacity-80" : "opacity-0 group-hover:opacity-40 group-hover:translate-x-0.5")}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Authentication / Locked Status Card */}
      {isAuthenticated ? (
        <button 
          onClick={() => setActiveView('settings')}
          className="hidden md:flex mx-4 mb-4 p-3.5 bg-bg-card/30 hover:bg-bg-card/55 rounded-2xl border border-olive/5 items-center gap-3 text-left transition-all cursor-pointer w-[calc(100%-2rem)] group/usercard"
        >
          <div className="h-9 w-9 bg-olive text-white rounded-xl transition-colors group-hover/usercard:bg-olive/85 flex items-center justify-center">
            <User size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[8px] font-black uppercase text-olive/55 tracking-wider">Active User</div>
            <div className="truncate text-xs font-bold text-ink">{username}</div>
          </div>
          <ChevronRight size={14} className="text-ink/25 transition-transform group-hover/usercard:translate-x-0.5" />
        </button>
      ) : (
        <div className="hidden md:flex mx-4 mb-4 p-3.5 bg-danger/5 rounded-2xl border border-danger/10 flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 bg-danger/10 text-danger rounded-xl animate-pulse flex items-center justify-center">
              <ShieldAlert size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-[8px] font-black uppercase text-danger/50 tracking-wider">Mesh Locked</div>
              <div className="text-xs font-bold text-ink">Sign in to view data</div>
            </div>
          </div>
          <button 
            onClick={() => setActiveView('settings')}
            className="w-full py-2.5 bg-danger/10 hover:bg-danger/20 text-danger rounded-xl text-[9px] font-black uppercase tracking-widest transition-all"
          >
            Login / Signup
          </button>
        </div>
      )}

      <div className="hidden md:block p-4 border-t border-olive/5 space-y-3 bg-white">
        <div className="space-y-3">
          <button 
            onClick={() => {
              const anyActive = metrics.activeCount > 0;
              setZones(prev => prev.map(z => {
                const nextActive = !anyActive;
                return { 
                  ...z, 
                  active: nextActive, 
                  status: nextActive ? 'Active' : (z.type === 'HVAC' ? 'Standby' : 'Idle'),
                  startTime: nextActive ? Date.now() : null
                };
              }));
              addToast(
                anyActive ? "Global isolation initiated" : "Full system mesh restoration", 
                anyActive ? Power : Zap
              );
            }}
            className={cn(
              "w-full py-3 rounded-2xl text-[10px] font-black uppercase tracking-[0.14em] transition-all flex items-center justify-center gap-3 shadow-lg group relative overflow-hidden",
              metrics.activeCount > 0 ? "bg-ink text-white shadow-ink/20 hover:bg-danger" : "bg-olive text-white shadow-olive/20 hover:bg-sage"
            )}
          >
            <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
            <Power size={14} className="relative z-10" />
            <span className="relative z-10">{metrics.activeCount > 0 ? 'Master Override' : 'System Restore'}</span>
          </button>
          
          <div className="p-1 bg-bg-card/60 rounded-2xl flex gap-1 border border-olive/5">
            <button 
              onClick={() => {
                setIsEcoMode(!isEcoMode);
                addToast(isEcoMode ? "Eco Mode Deactivated" : "Eco-Optimization Engaged", TrendingUp);
              }}
              className={cn(
                "flex-1 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all gap-2 flex items-center justify-center",
                isEcoMode ? "bg-olive text-white shadow-lg shadow-olive/10" : "text-ink/30 hover:text-ink"
              )}
            >
              <Wind size={12} />
              Eco
            </button>
            <button 
              disabled={isSyncing}
              onClick={() => {
                setIsSyncing(true);
                addToast("Synchronizing system topology...", Layers);
                setTimeout(() => setIsSyncing(false), 2000);
              }}
              className={cn(
                "flex-1 py-2.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all gap-2 flex items-center justify-center relative overflow-hidden",
                isSyncing ? "bg-bg-card text-olive cursor-wait" : "text-ink/30 hover:text-ink"
              )}
            >
              {isSyncing && (
                <motion.div 
                  initial={{ x: '-100%' }}
                  animate={{ x: '100%' }}
                  transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                  className="absolute inset-0 bg-olive/10"
                />
              )}
              <Layers size={12} className={cn(isSyncing && "animate-spin")} />
              {isSyncing ? 'Syncing...' : 'Sync Mesh'}
            </button>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-bg-card/25 border border-olive/10 relative overflow-hidden group">
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <div className="text-[9px] font-black uppercase text-ink/30 tracking-widest mb-1 group-hover:text-olive transition-colors">Grid Capacity</div>
              <div className="text-2xl font-display font-medium text-olive leading-none">{metrics.totalLoad} <span className="text-[10px] opacity-40">kW</span></div>
            </div>
            <div className="relative">
               <div className="w-10 h-10 rounded-full border border-sage/20 flex items-center justify-center">
                 <Activity size={14} className="text-sage/60 animate-pulse" />
               </div>
               <svg className="absolute inset-0 w-10 h-10 -rotate-90">
                 <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="2" className="text-sage/5" />
                 <motion.circle 
                    cx="20" cy="20" r="18" fill="none" stroke="#2D4C3B" strokeWidth="2" 
                    strokeLinecap="round" strokeDasharray="113" 
                    initial={{ strokeDashoffset: 113 }}
                    animate={{ strokeDashoffset: 113 - (parseFloat(metrics.totalLoad) / 2) * 113 }}
                 />
               </svg>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
