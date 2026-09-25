import React from 'react';
import { cn } from '../lib/utils';

interface StatItemProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: any;
  trend?: number;
}

export const StatItem = ({ label, value, sub, icon: Icon, trend }: StatItemProps) => (
  <div className="p-8 rounded-[2.5rem] bg-white border border-olive/10 shadow-sm transition-all hover:soft-shadow">
    <div className="flex justify-between items-start mb-6">
      <div className="p-3 rounded-2xl bg-bg-card text-sage shadow-sm border border-olive/5">
        <Icon size={24} />
      </div>
      {trend !== undefined && (
        <span className={cn("text-[10px] px-2 py-1 rounded-full font-black uppercase tracking-widest", trend > 0 ? "bg-clay/10 text-clay" : "bg-sage/10 text-sage")}>
          {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}%
        </span>
      )}
    </div>
    <div className="text-3xl font-display font-medium text-olive mb-1 leading-none">{value}</div>
    <div className="text-[10px] text-ink/30 uppercase font-black tracking-[0.2em]">{label}</div>
    {sub && <div className="text-[10px] text-ink/20 mt-2 font-bold uppercase tracking-widest">{sub}</div>}
  </div>
);
