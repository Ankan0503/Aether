import React from 'react';
import { motion } from 'motion/react';
import { Bell, ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

export const EventsView = () => (
  <motion.div 
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    className="max-w-5xl space-y-4 pb-20"
  >
    {[
      { title: 'System Recalibration', time: '2m ago', type: 'info', desc: 'Main kitchen node triggered thermal threshold reversal.' },
      { title: 'Energy Target Met', time: '1h ago', type: 'success', desc: 'Living room light cycle optimized for daylight.' },
      { title: 'Mesh Topology Update', time: '4h ago', type: 'info', desc: 'Zigbee channels updated for zero-latency drift.' },
    ].map((notif, i) => (
      <div key={i} className="p-6 2xl:p-8 rounded-[2.5rem] 2xl:rounded-[3rem] bg-white border border-olive/5 shadow-sm flex items-center justify-between group hover:bg-bg-card transition-all">
        <div className="flex items-center gap-8">
          <div className={cn("w-14 h-14 rounded-2xl flex items-center justify-center shrink-0", 
            notif.type === 'danger' ? "bg-danger/10 text-danger" : 
            notif.type === 'success' ? "bg-sage/10 text-sage" : "bg-bg-card text-ink/30"
          )}>
            <Bell size={24} />
          </div>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h5 className="font-bold text-ink">{notif.title}</h5>
              <span className="text-[10px] font-black text-ink/20">{notif.time}</span>
            </div>
            <p className="text-sm text-ink/40 font-medium">{notif.desc}</p>
          </div>
        </div>
        <ChevronRight size={20} className="text-ink/10 group-hover:text-olive transition-all" />
      </div>
    ))}
  </motion.div>
);
