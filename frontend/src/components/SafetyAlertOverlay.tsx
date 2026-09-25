import React from 'react';
import { motion } from 'motion/react';
import { Flame, ShieldAlert } from 'lucide-react';

interface SafetyAlertOverlayProps {
  type: 'fire' | 'gas';
  message: string;
  onDismiss: () => void;
}

export const SafetyAlertOverlay = ({ type, message, onDismiss }: SafetyAlertOverlayProps) => (
  <motion.div 
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-red-950/40 backdrop-blur-md"
  >
    <motion.div 
      initial={{ scale: 0.9, y: 20 }}
      animate={{ scale: 1, y: 0 }}
      className="max-w-md w-full bg-white rounded-[3rem] p-8 shadow-2xl border-4 border-danger relative overflow-hidden"
    >
      <div className="absolute inset-0 bg-danger/5 animate-pulse" />
      <div className="relative z-10 text-center">
        <div className="w-20 h-20 bg-danger rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-danger/20">
          {type === 'fire' ? <Flame size={40} className="text-white" /> : <ShieldAlert size={40} className="text-white" />}
        </div>
        <h2 className="text-3xl font-display font-bold text-ink mb-2 uppercase tracking-tighter">Critical Alert</h2>
        <p className="text-danger font-black text-xs uppercase tracking-[0.2em] mb-4">{type === 'fire' ? 'Flame Detected' : 'Gas Leak Detected'}</p>
        
        <div className="p-4 bg-bg-card rounded-2xl mb-8 border border-olive/10">
          <p className="text-sm text-ink/70 leading-relaxed font-medium">
            {message}
          </p>
        </div>

        <div className="space-y-3">
          <button 
            onClick={onDismiss}
            className="w-full py-4 bg-danger text-white font-black uppercase text-xs tracking-widest rounded-2xl shadow-xl shadow-danger/30 hover:bg-red-700 transition-all"
          >
            Acknowledge & Mute
          </button>
          <div className="text-[10px] text-ink/30 font-black uppercase tracking-widest">
            Aether is executing emergency shut-off protocol...
          </div>
        </div>
      </div>
    </motion.div>
  </motion.div>
);
