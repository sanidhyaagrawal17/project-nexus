import React from 'react';
import T from '../../lib/theme';

export const RiskGauge = ({ score, status }) => {
    const r = 48, circ = 2 * Math.PI * r, arc = circ * 0.75, filled = arc * (score / 100);
    const isCrit = status === 'Critical';
    const color  = isCrit ? T.crit : T.high;
    return (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, minWidth:120 }}>
            <svg width="120" height="90" viewBox="0 0 120 95">
                <circle cx="60" cy="68" r={r} fill="none" stroke={T.border} strokeWidth="8" strokeDasharray={`${arc} ${circ-arc}`} strokeDashoffset={circ*0.125} strokeLinecap="round"/>
                <circle cx="60" cy="68" r={r} fill="none" stroke={color} strokeWidth="8" strokeDasharray={`${filled} ${circ-filled}`} strokeDashoffset={circ*0.125} strokeLinecap="round" style={{ transition:'stroke-dasharray 0.6s ease', filter: 'drop-shadow(0 0 6px currentColor)' }}/>
                <text x="60" y="63" textAnchor="middle" fontSize="19" fontWeight="600" fill={color} fontFamily="'IBM Plex Mono', 'Courier New', monospace" style={{ textShadow: `0 0 8px ${color}` }}>{score.toFixed(1)}%</text>
                <text x="60" y="78" textAnchor="middle" fontSize="8" fill={T.txt3} fontFamily="monospace" letterSpacing="1.5">AI CONFIDENCE</text>
            </svg>
            <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color, background: isCrit ? T.critBg : T.highBg, border:`1px solid ${isCrit ? T.critBdr : T.highBdr}`, padding:'3px 10px', borderRadius:9999 }}>
                {status}
            </span>
        </div>
    );
};

export const RiskBar = ({ score, status }) => (
    <div style={{ height:4, background: T.raised, borderRadius:2, overflow:'hidden', marginTop:5, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)' }}>
        <div style={{ height:'100%', width:`${score}%`, borderRadius:2, transition:'width 0.5s ease', background: status === 'Critical' ? T.crit : T.high, boxShadow: `0 0 8px ${status === 'Critical' ? T.crit : T.high}` }} />
    </div>
);

export const StatusChip = ({ status }) => {
    const isCrit = status === 'Critical';
    return (
        <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', color: isCrit ? T.crit : T.high, background: isCrit ? T.critBg : T.highBg, border:`1px solid ${isCrit ? T.critBdr : T.highBdr}`, padding:'3px 10px', borderRadius:9999, whiteSpace:'nowrap' }}>
            {status}
        </span>
    );
};

export const ActorBadge = ({ actor }) => {
    const map = {
        SYSTEM:   { color:'#a1a1aa', bg:'rgba(161,161,170,0.1)', border:T.border },
        AI_ENGINE:{ color:'#818cf8', bg:'rgba(129,140,248,0.1)', border:'rgba(129,140,248,0.2)' },
        ANALYST:  { color:'#34d399', bg:'rgba(52,211,153,0.1)', border:'rgba(52,211,153,0.2)' },
    };
    const s = map[actor] || { color: T.txt2, bg: T.raised, border: T.border };
    return (
        <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', color:s.color, background:s.bg, border:`1px solid ${s.border}`, padding:'2px 8px', borderRadius:6 }}>
            {actor}
        </span>
    );
};

export const alertAgeMs = (detectedAt) => Date.now() - new Date(detectedAt || 0).getTime();
export const formatAge = (ms) => {
    const h = Math.floor(ms / 3600000);
    if (h < 24) return `${h}h`;
    const days = Math.floor(h / 24);
    return `${days}d ${h % 24}h`;
};
export const ageColor = (ms) => { const h = ms/3600000; if (h > 72) return T.crit; if (h > 24) return T.high; return T.ok; };

export const BarTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
        <div style={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8, padding:'12px 16px', fontSize:12, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }}>
            <p style={{ color:T.txt2, fontFamily:'monospace', marginBottom:4, fontSize:11 }}>{d.name}</p>
            <p style={{ color:T.txt1, marginBottom:6, fontWeight:600 }}>{d.fullName}</p>
            <p style={{ color:T.accent, fontWeight:700 }}>{d.count} occurrences</p>
        </div>
    );
};

export const ImportanceTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
        <div style={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8, padding:'12px 16px', fontSize:12, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }}>
            <p style={{ color:T.txt2, fontFamily:'monospace', marginBottom:4, fontSize:11 }}>{d.name}</p>
            {d.fullName && <p style={{ color:T.txt1, marginBottom:6, fontWeight:600 }}>{d.fullName}</p>}
            <p style={{ color:T.accent, fontWeight:700 }}>Importance: {typeof d.importance === 'number' ? d.importance.toFixed(4) : '—'}</p>
        </div>
    );
};

export const AlertAge = ({ detectedAt }) => {
    const ms    = alertAgeMs(detectedAt);
    const color = ageColor(ms);
    const text  = formatAge(ms);
    const h     = ms / 3600000;
    return (
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
            <span style={{ fontSize:12, fontWeight:700, color, fontFamily:'monospace' }}>{text}</span>
            {h > 72 && <span style={{ fontSize:9, color:T.crit, fontWeight:800, textTransform:'uppercase', letterSpacing:'0.08em' }}>OVERDUE</span>}
            {h > 24 && h <= 72 && <span style={{ fontSize:9, color:T.high, fontWeight:800, textTransform:'uppercase', letterSpacing:'0.08em' }}>SLA WARNING</span>}
        </div>
    );
};

export const ConfusionMatrix = ({ matrix }) => {
    if (!matrix || !Array.isArray(matrix) || matrix.length < 2) return null;
    const [[TN, FP], [FN, TP]] = matrix;
    const total = TN + FP + FN + TP || 1;
    const cells = [
        { label:'True Positive',  sub:'Fraud correctly caught',    val:TP, pct:(TP/total*100).toFixed(1), color:T.ok,   bg:T.okBg   },
        { label:'False Positive', sub:'Legitimate flagged as risk', val:FP, pct:(FP/total*100).toFixed(1), color:T.high, bg:T.highBg },
        { label:'False Negative', sub:'Fraud that was missed',      val:FN, pct:(FN/total*100).toFixed(1), color:T.crit, bg:T.critBg },
        { label:'True Negative',  sub:'Legitimate correctly safe',  val:TN, pct:(TN/total*100).toFixed(1), color:T.txt2, bg:T.raised  },
    ];
    return (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {cells.map(({ label, sub, val, pct, color, bg }) => (
                <div key={label} style={{ background:bg, border:`1px solid ${color}30`, borderRadius:10, padding:'16px 18px' }}>
                    <div style={{ fontSize:10, color, textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:800, marginBottom:6 }}>{label}</div>
                    <div style={{ fontSize:28, fontWeight:800, fontFamily:'monospace', color }}>{(val||0).toLocaleString()}</div>
                    <div style={{ fontSize:11, color:T.txt3, marginTop:5 }}>{pct}% of total · {sub}</div>
                </div>
            ))}
        </div>
    );
};

export const ThresholdSlider = ({ alertThreshold, critThreshold, activeAccent, onApply }) => {
    const [alert, setAlert] = React.useState(alertThreshold || 0.85);
    const [crit,  setCrit]  = React.useState(critThreshold  || 0.95);
    return (
        <div style={{ padding:'20px 24px', background:T.raised, border:`1px solid ${T.border}`, borderRadius:12, marginTop:16 }}>
            <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:16, fontWeight:700 }}>Interactive Threshold Tuning</div>
            {[
                { label:'Alert Threshold',    val:alert, set:setAlert, color:T.high },
                { label:'Critical Threshold', val:crit,  set:setCrit,  color:T.crit },
            ].map(({ label, val, set, color }) => (
                <div key={label} style={{ marginBottom:16 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                        <span style={{ fontSize:12, color:T.txt2, fontWeight:600 }}>{label}</span>
                        <span style={{ fontSize:14, fontWeight:800, fontFamily:'monospace', color }}>{(val*100).toFixed(0)}%</span>
                    </div>
                    <input type="range" min={0.1} max={0.99} step={0.01} value={val} onChange={e => set(parseFloat(e.target.value))}
                        style={{ width:'100%', accentColor:color }} />
                </div>
            ))}
            <div style={{ display:'flex', justifyContent:'flex-end', gap:10 }}>
                <button onClick={() => { setAlert(alertThreshold || 0.85); setCrit(critThreshold || 0.95); }} style={{ padding:'8px 16px', borderRadius:8, border:`1px solid ${T.border}`, background:'transparent', color:T.txt2, fontSize:12, fontWeight:600, cursor:'pointer' }}>Reset</button>
                <button onClick={() => onApply && onApply(alert, crit)} style={{ padding:'8px 16px', borderRadius:8, border:`1px solid ${activeAccent}`, background:activeAccent, color:'#fff', fontSize:12, fontWeight:700, cursor:'pointer' }}>Apply Thresholds</button>
            </div>
        </div>
    );
};

export const TH = ({ children, right }) => (
    <th style={{ padding:'12px 16px', fontSize:10, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:T.txt3, background:T.surface, borderBottom:`1px solid ${T.border}`, textAlign: right ? 'right' : 'left', whiteSpace:'nowrap', userSelect:'none' }}>
        {children}
    </th>
);

export const TD = ({ children, right, mono, muted }) => (
    <td style={{ padding:'14px 16px', verticalAlign:'middle', fontSize:13, color: muted ? T.txt2 : T.txt1, textAlign: right ? 'right' : 'left', fontFamily: mono ? "'IBM Plex Mono', monospace" : 'inherit' }}>
        {children}
    </td>
);

export const Card = ({ children, style }) => (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:12, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', overflow:'hidden', ...style }}>
        {children}
    </div>
);

export const PadCard = ({ children, style }) => (
    <Card style={{ padding:24, ...style }}>
        {children}
    </Card>
);

export const MetricCard = ({ label, value, color = T.txt1, note }) => (
    <Card style={{ padding:'18px 20px', display:'flex', flexDirection:'column', justifyContent:'center' }}>
        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:10 }}>{label}</div>
        <div style={{ fontSize:28, fontWeight:800, color, fontFamily:'monospace', textShadow: color !== T.txt1 ? `0 0 12px ${color}60` : 'none' }}>{value}</div>
        {note && <div style={{ fontSize:11, color:T.txt3, marginTop:8 }}>{note}</div>}
    </Card>
);

export const PanelHeader = ({ kicker, title, description }) => (
    <>
        <div style={{ fontSize:11, fontWeight:700, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:6 }}>{kicker}</div>
        <div style={{ fontSize:18, fontWeight:700, color:T.txt1, marginBottom:8 }}>{title}</div>
        {description ? <div style={{ fontSize:12, color:T.txt2, marginBottom:16, lineHeight:1.6 }}>{description}</div> : null}
    </>
);

export const hoverBorderButtonProps = (baseColor = T.txt3, hoverColor = T.txt1, hoverBorder = T.borderHi, hoverBackground = T.raised) => ({
    onMouseEnter: e => {
        e.currentTarget.style.color = hoverColor;
        e.currentTarget.style.borderColor = hoverBorder;
        e.currentTarget.style.background = hoverBackground;
        e.currentTarget.style.boxShadow = `0 0 12px ${hoverBackground}`;
    },
    onMouseLeave: e => {
        e.currentTarget.style.color = baseColor;
        e.currentTarget.style.borderColor = T.border;
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.boxShadow = 'none';
    },
});

export const Divider = () => <div style={{ height:1, background:T.border }} />;

export const Pagination = ({ current, total, onPrev, onNext, jumpPage, onJumpChange, onJumpKey }) => {
    if (total <= 1) return null;
    const btn = (label, onClick, disabled) => (
        <button onClick={onClick} disabled={disabled} style={{
            padding:'6px 16px', fontSize:12, fontWeight:600, borderRadius:8, cursor: disabled ? 'not-allowed' : 'pointer',
            background: T.raised, border:`1px solid ${T.borderHi}`, color: disabled ? T.txt3 : T.txt2,
            transition:'all 0.2s ease',
        }}>
            {label}
        </button>
    );
    return (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 20px', background:T.surface, borderTop:`1px solid ${T.border}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em' }}>Jump</span>
                <input type="text" value={jumpPage} onChange={onJumpChange} onKeyDown={onJumpKey} placeholder="#"
                    style={{ width:44, padding:'6px 8px', fontSize:12, textAlign:'center', borderRadius:6, background:T.bg, border:`1px solid ${T.borderHi}`, color:T.txt1, outline:'none', fontFamily:'monospace' }} />
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                {btn('← Prev', onPrev, current === 1)}
                <span style={{ fontSize:12, fontFamily:'monospace', color:T.txt2, padding:'0 8px' }}>
                    <span style={{ color:T.txt1, fontWeight:700 }}>{current}</span>
                    <span style={{ color:T.txt3 }}> / {total}</span>
                </span>
                {btn('Next →', onNext, current === total)}
            </div>
        </div>
    );
};

export default {
    RiskGauge, RiskBar, StatusChip, ActorBadge, BarTooltip, ImportanceTooltip, AlertAge,
    ConfusionMatrix, ThresholdSlider, TH, TD, Card, PadCard, MetricCard, hoverBorderButtonProps, Divider, Pagination,
};
