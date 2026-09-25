import React from 'react';
import { motion } from 'motion/react';
import { Flame, Wind, Power, ShieldAlert, Globe } from 'lucide-react';
import { cn } from '../lib/utils';

interface SafetyHubViewProps {
  gasLevel: number;
  isFlame: boolean;
  systemStatus: string;
  onResetSafety: () => void;
  resetCompleted: boolean;
  isSecurityLocked: boolean;
  setIsSecurityLocked: (v: boolean) => void;
}

export const SafetyHubView = ({ 
  gasLevel, 
  isFlame, 
  systemStatus, 
  onResetSafety, 
  resetCompleted,
  isSecurityLocked,
  setIsSecurityLocked
}: SafetyHubViewProps) => (
  <div className="space-y-8 2xl:space-y-10 pb-20">
    {systemStatus !== "SAFE" && !resetCompleted && (
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="p-4 sm:p-8 rounded-[1.75rem] sm:rounded-[3.5rem] bg-red-50 border-2 border-danger shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-5 sm:gap-6 relative overflow-hidden"
      >
        <div className="absolute inset-0 bg-danger/5 animate-pulse" />
        <div className="relative z-10 flex items-start sm:items-center gap-4 sm:gap-6">
          <div className="p-4 sm:p-5 rounded-2xl bg-danger text-white animate-bounce shadow-md">
            <Power size={24} />
          </div>
          <div>
            <h4 className="text-lg sm:text-xl font-display font-bold text-ink mb-1">
              Safety Lockout Engaged ({systemStatus.replace('_', ' ')})
            </h4>
            <p className="text-xs font-semibold text-ink/60 leading-relaxed max-w-xl">
              Power grid cut off is actively engaged. Once you have inspected the premises and ensured all fire/gas hazards are fully cleared, press the button to restore electricity to your home network.
            </p>
          </div>
        </div>
        <button
          onClick={onResetSafety}
          className="relative z-10 w-full md:w-auto px-6 sm:px-8 py-4 bg-danger hover:bg-red-700 text-white font-black text-[10px] uppercase tracking-widest rounded-2xl transition-all shadow-lg shadow-danger/20 hover:scale-[1.03] active:scale-[1.02]"
        >
          Restore System Power
        </button>
      </motion.div>
    )}

    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6 2xl:gap-10"
    >
      <div className={cn("p-4 sm:p-6 xl:p-8 2xl:p-12 rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] border-2 transition-all duration-700 bg-white border-olive/5 shadow-sm", isFlame && "border-danger bg-danger/5 shadow-2xl shadow-danger/20")}>
        <div className="flex justify-between items-start mb-8 2xl:mb-12">
          <div className="flex items-center gap-6">
            <div className={cn("p-5 sm:p-8 rounded-[1.75rem] sm:rounded-[2.5rem] soft-shadow transition-transform", isFlame ? "bg-danger text-white scale-110" : "bg-bg-card text-ink/30")}>
              <Flame size={40} />
            </div>
            <div>
              <h4 className="text-xl sm:text-2xl font-display font-medium text-ink leading-tight mb-2 italic">Infrared <br /> Thermal Array</h4>
              <p className="text-xs font-bold text-ink/30 uppercase tracking-widest">MQ-2 + IR Shielding Active</p>
            </div>
          </div>
        </div>
        <div className="space-y-4">
            <div className="p-6 bg-bg-card/20 rounded-3xl border border-olive/5 flex items-center justify-between">
              <span className="text-sm font-bold text-ink/60">Molecular Shutter Status</span>
              <span className={cn("text-[10px] font-black uppercase px-2 py-1 rounded", isFlame ? "bg-danger text-white px-3" : "bg-sage/10 text-sage")}>
                {isFlame ? 'LOCKED' : 'OPEN'}
              </span>
            </div>
        </div>
      </div>

      <div className="p-4 sm:p-6 xl:p-8 2xl:p-12 rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] bg-white border border-olive/5 shadow-sm space-y-8 2xl:space-y-12">
        <div>
          <div className="flex items-center gap-6 mb-10">
            <div className={cn("p-5 sm:p-8 rounded-[1.75rem] sm:rounded-[2.5rem] shadow-sm", gasLevel > 300 ? "bg-clay text-white" : "bg-bg-card text-ink/20")}>
              <Wind size={40} />
            </div>
            <div>
              <h4 className="text-xl sm:text-2xl font-display font-medium text-ink italic leading-tight mb-2">Molecular <br /> Concentration</h4>
              <p className="text-xs font-bold text-ink/30 uppercase tracking-widest">{gasLevel.toFixed(1)} PPM</p>
            </div>
          </div>
          <div className="h-4 w-full bg-bg-card rounded-full overflow-hidden relative mb-6">
            <motion.div animate={{ width: `${(gasLevel / 450) * 100}%` }} className={cn("h-full relative z-10 transition-colors", gasLevel > 300 ? "bg-clay" : "bg-sage")} />
          </div>
          <p className="text-xs text-ink/40 leading-relaxed font-medium">Monitoring Methane, LPG, and Smoke particles across Zone 1-12 metadata clusters.</p>
        </div>
      </div>

      <div className="p-4 sm:p-6 xl:p-8 2xl:p-12 rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] bg-olive text-white shadow-2xl shadow-olive/20 relative overflow-hidden flex flex-col min-h-[280px] sm:min-h-[300px]">
        <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 blur-3xl rounded-full translate-x-1/2 -translate-y-1/2" />
        <ShieldAlert size={140} className="absolute -bottom-10 -right-10 opacity-5" />
        
        <h4 className="text-[10px] font-black uppercase tracking-[0.3em] mb-12 opacity-60">System Security</h4>
        <div className="text-3xl sm:text-4xl font-display font-medium mb-4 italic leading-[1.1]">Mesh <br /> {isSecurityLocked ? 'Protected' : 'Unlocked'}.</div>
        <p className="text-[11px] opacity-60 mb-10 font-medium italic leading-relaxed">
          {isSecurityLocked 
            ? 'Active safety interlocks engaged. Relay power cutoff will trip instantly upon detecting hazards.' 
            : 'Safety interlocks bypassed. Warning system is active, but automatic power shutdown is disabled.'}
        </p>
        
        <div className="mt-auto">
          <div 
            onClick={() => setIsSecurityLocked(!isSecurityLocked)}
            className="p-5 bg-white/10 rounded-[2rem] border border-white/10 backdrop-blur-sm flex items-center justify-between cursor-pointer group"
          >
            <div className="flex items-center gap-4">
              <div className="p-2 bg-sage/20 rounded-xl transition-colors group-hover:bg-sage/40">
                <Globe size={14} />
              </div>
              <span className="text-[10px] font-bold uppercase tracking-widest">Global Lock</span>
            </div>
            <div className={cn(
              "w-10 h-6 rounded-full relative p-1 transition-colors duration-300",
              isSecurityLocked ? "bg-sage" : "bg-white/20"
            )}>
              <motion.div 
                animate={{ x: isSecurityLocked ? 16 : 0 }}
                className="w-4 h-4 bg-white rounded-full shadow-sm" 
              />
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  </div>
);
