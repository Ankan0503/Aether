import React from 'react';
import { motion } from 'motion/react';
import { Cpu, Zap, Plus, ShieldAlert, Globe } from 'lucide-react';
import { SmartRule } from '../services/geminiService';
import { cn } from '../lib/utils';

interface AutomationViewProps {
  zones: any[];
  addToast: any;
  onToggleRule: (zoneId: string, ruleIndex: number) => void;
  onNewMacro: () => void;
  onGlobalTrigger: () => void;
  onAiOptimize: () => void;
  isLoading: boolean;
  suggestions: SmartRule[];
  onDeployAiRule: (text: string) => void;
}

export const AutomationView = ({ 
  zones, 
  addToast, 
  onToggleRule, 
  onNewMacro, 
  onGlobalTrigger,
  onAiOptimize,
  isLoading,
  suggestions,
  onDeployAiRule
}: AutomationViewProps) => (
  <motion.div 
    initial={{ opacity: 0, x: 20 }}
    animate={{ opacity: 1, x: 0 }}
    className="space-y-8 2xl:space-y-10 pb-20"
  >
    <div className="flex flex-col xl:flex-row xl:justify-between xl:items-start gap-5">
      <div>
        <h2 className="text-2xl sm:text-4xl font-display font-medium text-ink leading-tight sm:leading-none mb-3">Automation Hub</h2>
        <p className="text-[10px] text-ink/30 font-black uppercase tracking-[0.3em]">Decentralized trigger propagation</p>
      </div>
      <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-3 xl:gap-4 w-full xl:w-auto">
        <button 
          onClick={onAiOptimize}
          disabled={isLoading}
          className={cn(
            "px-6 sm:px-8 py-4 bg-white border border-olive/10 text-olive rounded-2xl sm:rounded-[2rem] text-[10px] font-black uppercase tracking-widest shadow-xl shadow-olive/5 hover:bg-olive hover:text-white transition-all flex items-center justify-center gap-3",
            isLoading && "opacity-50 cursor-wait"
          )}
        >
          {isLoading ? (
            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}>
              <Cpu size={16} />
            </motion.div>
          ) : (
            <Zap size={16} />
          )}
          AI Optimize
        </button>
        <button 
          onClick={onNewMacro}
          className="px-6 sm:px-8 py-4 bg-ink text-white rounded-2xl sm:rounded-[2rem] text-[10px] font-black uppercase tracking-widest shadow-xl shadow-ink/20 hover:bg-olive transition-all flex items-center justify-center gap-3"
        >
          <Plus size={16} />
          New Macro
        </button>
      </div>
    </div>

    {suggestions.length > 0 && (
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-olive p-4 sm:p-6 xl:p-8 2xl:p-10 rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] text-white overflow-hidden relative"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 blur-3xl rounded-full translate-x-1/3 -translate-y-1/3" />
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-6">
             <div className="p-3 bg-white/10 rounded-2xl">
               <Cpu size={24} />
             </div>
             <div>
                <h3 className="text-xl font-display font-medium italic">Aether AI Insights</h3>
                <p className="text-[9px] font-black uppercase tracking-widest opacity-60">Synthesized Macro Proposals</p>
             </div>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 2xl:gap-6">
            {suggestions.map((suggestion, i) => (
              <div key={i} className="p-5 2xl:p-6 bg-white/10 border border-white/10 rounded-[2rem] 2xl:rounded-[2.5rem] backdrop-blur-sm flex flex-col justify-between group">
                <div>
                  <div className="text-[11px] font-black text-white/40 uppercase tracking-widest mb-3">Protocol Prop {i+1}</div>
                  <h4 className="text-sm font-bold italic mb-2">"{suggestion.text}"</h4>
                  <p className="text-[9px] opacity-60 italic leading-relaxed">{suggestion.reason}</p>
                </div>
                <button 
                  onClick={() => onDeployAiRule(suggestion.text)}
                  className="mt-6 w-full py-3 bg-white text-olive rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-sage hover:text-white transition-all"
                >
                  Apply Rule
                </button>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    )}

    <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-6 2xl:gap-8">
      {zones.map(zone => (
        <div key={zone.id} className="bg-white rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] p-4 sm:p-6 xl:p-8 2xl:p-10 border border-olive/10 soft-shadow group">
          <div className="flex items-center gap-4 sm:gap-5 mb-6 sm:mb-8 2xl:mb-10">
            <div className={cn("p-4 sm:p-5 rounded-2xl sm:rounded-3xl bg-bg-card shadow-sm transition-all group-hover:scale-110", zone.color)}>
              <zone.icon size={24} />
            </div>
            <div>
              <h3 className="text-xl font-display font-medium text-ink italic">{zone.name}</h3>
              <p className="text-[9px] text-ink/20 font-black uppercase tracking-widest mt-0.5">{zone.rules.length} Active Protocols</p>
            </div>
          </div>
          
          <div className="space-y-3 2xl:space-y-4 mb-8 2xl:mb-10">
            {zone.rules.map((rule: any, i: number) => (
              <div key={i} className="p-3 sm:p-4 2xl:p-5 bg-bg-card/50 rounded-2xl sm:rounded-[1.5rem] 2xl:rounded-[2rem] border border-transparent hover:border-olive/10 transition-all group/rule flex items-center justify-between gap-3">
                <div className="flex items-center gap-4">
                  <div className={cn("w-1.5 h-1.5 rounded-full shadow-sm transition-colors", rule.active ? "bg-sage" : "bg-ink/10")} />
                  <span className={cn("text-[11px] font-bold italic transition-all", rule.active ? "text-ink/70 opacity-80 group-hover/rule:opacity-100" : "text-ink/20 line-through")}>
                    {rule.text}
                  </span>
                </div>
                <div 
                  onClick={() => onToggleRule(zone.id, i)}
                  className={cn("w-8 h-4 rounded-full relative p-0.5 cursor-pointer transition-colors", rule.active ? "bg-sage/20" : "bg-ink/5")}
                >
                  <motion.div 
                    animate={{ x: rule.active ? 16 : 0 }}
                    className={cn("w-3 h-3 rounded-full shadow-sm transition-colors", rule.active ? "bg-sage" : "bg-ink/20")} 
                  />
                </div>
              </div>
            ))}
          </div>

          <button 
            onClick={() => addToast(`Re-deploying protocols for ${zone.name}`, Cpu)}
            className="w-full py-5 border border-olive/5 bg-bg-card/30 rounded-[2rem] text-[9px] font-black uppercase tracking-widest text-ink/30 hover:bg-olive hover:text-white transition-all flex items-center justify-center gap-3"
          >
            <Cpu size={14} />
            Deploy Protocol
          </button>
        </div>
      ))}

      <div 
        onClick={onGlobalTrigger}
        className="bg-bg-card/30 rounded-[1.75rem] sm:rounded-[2.5rem] 2xl:rounded-[4rem] border-2 border-dashed border-olive/10 flex flex-col items-center justify-center p-6 sm:p-8 2xl:p-12 text-center group cursor-pointer hover:border-olive/30 transition-all min-h-[220px] sm:min-h-[280px]"
      >
         <div className="p-8 bg-white/50 rounded-full mb-6 group-hover:scale-110 transition-transform shadow-xl shadow-black/5">
            <Plus size={32} className="text-ink/10 group-hover:text-olive transition-colors" />
         </div>
         <h4 className="text-xl font-display font-medium text-ink/20 group-hover:text-ink/40 transition-colors uppercase tracking-widest">Global Trigger</h4>
      </div>
    </div>
  </motion.div>
);
