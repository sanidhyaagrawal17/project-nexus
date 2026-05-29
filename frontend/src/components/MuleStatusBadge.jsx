import React from 'react';

const T = {
    txt2: '#8b8fa3',
    bg: '#111214',
    border: '#2c2e36',
    crit: '#d97634',
    critBg: '#221a0f',
    critBdr: '#3d2a12',
    ok: '#4a9e6e',
    okBg: '#0d1f16',
};

export default function MuleStatusBadge({ status }) {
    const s = String(status || 'Pending');
    const map = {
        Pending: { color: T.txt2, bg: T.bg, border: T.border },
        'Confirmed Mule': { color: T.crit, bg: T.critBg, border: T.critBdr },
        'Not a Mule': { color: T.ok, bg: T.okBg, border: '#163028' },
    };
    const style = map[s] || map['Pending'];
    return (
        <span data-testid="mule-badge" style={{ fontSize:11, fontWeight:800, letterSpacing:'0.06em', textTransform:'uppercase',
            color: style.color, background: style.bg, border:`1px solid ${style.border}`,
            padding:'6px 10px', borderRadius:8, minWidth:90, display:'inline-block', textAlign:'center' }}>{s}</span>
    );
}
