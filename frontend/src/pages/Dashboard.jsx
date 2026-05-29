import React, { useState, useEffect, useRef, useMemo } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';
import { io } from 'socket.io-client';
import toast, { Toaster } from 'react-hot-toast';
import MuleStatusBadge from '../components/MuleStatusBadge.jsx';

/* eslint-disable react-hooks/exhaustive-deps */

const T = {
    bg: '#111214',
    surface: '#18191d',
    raised: '#1e2026',
    border: '#2c2e36',
    borderHi: '#383a46',
    txt1: '#dde0e8',
    txt2: '#8b8fa3',
    txt3: '#555769',
    accent: '#5b6af0',
    accentBg: '#1e2140',
    crit: '#d97634',
    critBg: '#221a0f',
    critBdr: '#3d2a12',
    high: '#4a8fd4',
    highBg: '#0d1a2a',
    highBdr: '#1a3050',
    ok: '#4a9e6e',
    okBg: '#0d1f16',
};

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const UPLOAD_STATUS_COPY = {
    idle: {
        label: 'Idle',
        detail: 'Waiting for a CSV upload.',
        kind: 'idle',
        phase: 0,
    },
    'uploading file...': {
        label: 'Uploading',
        detail: 'Sending the CSV to the ML engine.',
        kind: 'active',
        phase: 1,
    },
};

const UPLOAD_PROGRESS_STEPS = [
    { label: 'Upload' },
    { label: 'Hash' },
    { label: 'Score' },
    { label: 'Commit' },
    { label: 'Done' },
];

const sampleDatasets = [
    {
        name: 'Credit Card Fraud Detection',
        kind: 'Wide CSV',
        summary: 'Classic severe imbalance benchmark for quick scoring checks.',
        url: 'https://www.kaggle.com/datasets/mlg-ulb/creditcardfraud',
    },
    {
        name: 'PaySim Synthetic Fraud Data',
        kind: 'Transaction CSV',
        summary: 'Best fit for sender/receiver style transaction telemetry.',
        url: 'https://www.kaggle.com/datasets/ealaxi/paysim1',
    },
    {
        name: 'Elliptic Bitcoin Graph',
        kind: 'Graph',
        summary: 'Ideal for the transaction graph path and node aggregation.',
        url: 'https://www.kaggle.com/datasets/ellipticco/elliptic-data-set',
    },
    {
        name: 'Default of Credit Card Clients',
        kind: 'Tabular Credit Risk',
        summary: 'Lightweight sanity-check data for the general analytics flow.',
        url: 'https://archive.ics.uci.edu/dataset/350/default+of+credit+card+clients',
    },
    {
        name: 'IBM TabFormer',
        kind: 'Sequence',
        summary: 'Useful for sequential transaction behavior and time ordering.',
        url: 'https://github.com/IBM/TabFormer',
    },
];

const getUploadStatusMeta = (status) => {
    const normalized = String(status || 'Idle').trim().toLowerCase();
    return UPLOAD_STATUS_COPY[normalized] || {
        label: status || 'Idle',
        detail: 'Processing the current file.',
        kind: 'active',
        phase: 2,
    };
};

const formatDuration = (seconds) => {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

const formatMetricDisplay = (value, sampleCount) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
    const numeric = Number(value);
    if (sampleCount && sampleCount < 20) return numeric.toFixed(3);
    return numeric.toFixed(3);
};

const featureDictionary = {
    F115: 'High-Velocity Transfer Bursts',
    F321: 'Immediate Cash-Out After Inflow',
    F527: 'Geographic / IP Mismatch',
    F531: 'Off-Hours Transaction Spike',
    F670: 'Structured Transaction Splitting',
    F1692: 'New Beneficiary Linkage',
    F2082: 'Shared Device Indicator',
    F2122: 'Multi-Account Overlap',
    F2582: 'Rapid Merchant Cycling',
    F2678: 'Short-Lived Balance Spike',
    F2737: 'Cross-Border Routing Pattern',
    F2956: 'Dormancy Breakout',
    F3043: 'Night-Time Escalation',
    F3836: 'Velocity Cap Breach',
    F3887: 'Circular Flow Indicator',
    F3889: 'Pass-Through Ratio Spike',
    F3891: 'Related-Party Concentration',
    F3894: 'Network Reciprocity Spike',
    Anomaly_Score: 'Statistical Deviation',
};

const normalizeFeatureImpact = (feature) => {
    if (!feature) return null;
    if (typeof feature === 'string') {
        return { name: feature, raw: null, contribution: null, direction: null };
    }
    const name = feature.name || feature.feature || feature.code || 'Unknown Signal';
    const contribution = typeof feature.contribution === 'number' ? feature.contribution : null;
    return {
        ...feature,
        name,
        raw: typeof feature.raw === 'number' ? feature.raw : null,
        contribution,
        direction: feature.direction || (contribution === null ? null : contribution >= 0 ? 'UP' : 'DOWN'),
    };
};

const featureLabel = (code) => featureDictionary[code] || `Feature ${code}`;
const getAlertFeatures = (alert) => (alert.topFeatures || []).map(normalizeFeatureImpact).filter(Boolean);

const featureCat = (code) => {
    if (['F115','F321','F670','F3836','F531','F3894','F3891','F3887','F3889'].includes(code)) return { bg:'#1f1410', color:'#c4783a', border:'#3a2210' };
    if (['F527','F2737'].includes(code)) return { bg:'#101820', color:'#5a9ed4', border:'#1a3048' };
    if (['F2082','F2122'].includes(code)) return { bg:'#161024', color:'#8b72cc', border:'#2a1e48' };
    if (['F1692','F2956','F2582','F2678','F3043'].includes(code)) return { bg:'#0e1a18', color:'#4a9e82', border:'#163028' };
    return { bg:'#111630', color:'#6a7ae8', border:'#1e2650' };
};

const translate = (code) => featureLabel(code);

const fmtThreshold = (v) => {
    if (v === null || v === undefined) return '';
    const num = Number(v);
    if (Number.isNaN(num)) return String(v);
    if (Math.abs(num) <= 1) return `${(num * 100).toFixed(0)}%`;
    return `${num.toFixed(0)}%`;
};

const RiskGauge = ({ score, status }) => {
    const r = 48;
    const circ = 2 * Math.PI * r;
    const arc = circ * 0.75;
    const filled = arc * (score / 100);
    const isCrit = status === 'Critical';
    const color = isCrit ? T.crit : T.high;

    return (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6, minWidth:120 }}>
            <svg width="120" height="90" viewBox="0 0 120 95">
                <circle cx="60" cy="68" r={r} fill="none" stroke={T.border} strokeWidth="8" strokeDasharray={`${arc} ${circ - arc}`} strokeDashoffset={circ * 0.125} strokeLinecap="round" />
                <circle cx="60" cy="68" r={r} fill="none" stroke={color} strokeWidth="8" strokeDasharray={`${filled} ${circ - filled}`} strokeDashoffset={circ * 0.125} strokeLinecap="round" style={{ transition:'stroke-dasharray 0.6s ease' }} />
                <text x="60" y="63" textAnchor="middle" fontSize="19" fontWeight="600" fill={color}>{score.toFixed(1)}%</text>
                <text x="60" y="83" textAnchor="middle" fontSize="10" fill={T.txt3} fontWeight="600" letterSpacing="0.08em">{status}</text>
            </svg>
        </div>
    );
};

const RiskBar = ({ score, status }) => (
    <div style={{ height:3, background:T.border, borderRadius:2, overflow:'hidden', marginTop:5 }}>
        <div style={{ height:'100%', width:`${score}%`, borderRadius:2, transition:'width 0.5s ease', background: status === 'Critical' ? T.crit : T.high }} />
    </div>
);

const StatusChip = ({ status }) => {
    const isCrit = status === 'Critical';
    return (
        <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', color:isCrit ? T.crit : T.high, background:isCrit ? T.critBg : T.highBg, border:`1px solid ${isCrit ? T.critBdr : T.highBdr}`, padding:'2px 8px', borderRadius:3, whiteSpace:'nowrap' }}>{status}</span>
    );
};

const ActorBadge = ({ actor }) => {
    const map = {
        SYSTEM: { color:'#8b8fa3', bg:'#1e2026', border:T.border },
        AI_ENGINE: { color:'#6a7ae8', bg:'#111630', border:'#1e2650' },
        ANALYST: { color:'#4a9e6e', bg:'#0d1f16', border:'#163028' },
    };
    const s = map[actor] || { color:T.txt2, bg:T.raised, border:T.border };
    return <span style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', color:s.color, background:s.bg, border:`1px solid ${s.border}`, padding:'2px 8px', borderRadius:3 }}>{actor}</span>;
};

const BarTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
        <div style={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:6, padding:'10px 14px', fontSize:12 }}>
            <p style={{ color:T.txt2, fontFamily:'monospace', marginBottom:2, fontSize:11 }}>{d.name}</p>
            <p style={{ color:T.txt1, marginBottom:4 }}>{d.fullName}</p>
            <p style={{ color:T.accent, fontWeight:600 }}>{d.count} occurrences</p>
        </div>
    );
};

const TH = ({ children, right }) => (
    <th style={{ padding:'10px 16px', fontSize:10, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:T.txt3, background:T.bg, borderBottom:`1px solid ${T.border}`, textAlign: right ? 'right' : 'left', whiteSpace:'nowrap', userSelect:'none' }}>{children}</th>
);

const TD = ({ children, right, mono, muted }) => (
    <td style={{ padding:'12px 16px', verticalAlign:'middle', fontSize:13, color: muted ? T.txt2 : T.txt1, textAlign: right ? 'right' : 'left', fontFamily: mono ? "'IBM Plex Mono', monospace" : 'inherit' }}>{children}</td>
);

const Card = ({ children, style }) => (
    <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden', ...style }}>{children}</div>
);

const PadCard = ({ children, style }) => (
    <Card style={{ padding:20, ...style }}>{children}</Card>
);

const MetricCard = ({ label, value, color = T.txt1, note }) => (
    <Card style={{ padding:'16px 18px' }}>
        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:8 }}>{label}</div>
        <div style={{ fontSize:24, fontWeight:700, color, fontFamily:'monospace' }}>{value}</div>
        {note && <div style={{ fontSize:11, color:T.txt3, marginTop:6 }}>{note}</div>}
    </Card>
);

const PanelHeader = ({ kicker, title, description }) => (
    <>
        <div style={{ fontSize:11, fontWeight:700, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6 }}>{kicker}</div>
        <div style={{ fontSize:18, fontWeight:700, color:T.txt1, marginBottom:6 }}>{title}</div>
        {description ? <div style={{ fontSize:11, color:T.txt2, marginBottom:12, lineHeight:1.5 }}>{description}</div> : null}
    </>
);

const Divider = () => <div style={{ height:1, background:T.border }} />;

const Pagination = ({ current, total, onPrev, onNext, jumpPage, onJumpChange, onJumpKey }) => {
    if (total <= 1) return null;
    const btn = (label, onClick, disabled) => (
        <button onClick={onClick} disabled={disabled} style={{ padding:'5px 14px', fontSize:12, fontWeight:600, borderRadius:5, cursor: disabled ? 'not-allowed' : 'pointer', background:T.raised, border:`1px solid ${T.borderHi}`, color: disabled ? T.txt3 : T.txt2, transition:'color 0.15s, background 0.15s' }} onMouseEnter={e => { if (!disabled) { e.currentTarget.style.color = T.txt1; e.currentTarget.style.background = T.raised; } }} onMouseLeave={e => { e.currentTarget.style.color = disabled ? T.txt3 : T.txt2; }}>{label}</button>
    );
    return (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 16px', background:T.surface, borderTop:`1px solid ${T.border}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em' }}>Jump</span>
                <input type="text" value={jumpPage} onChange={onJumpChange} onKeyDown={onJumpKey} placeholder="#" style={{ width:40, padding:'4px 8px', fontSize:12, textAlign:'center', borderRadius:4, background:T.bg, border:`1px solid ${T.borderHi}`, color:T.txt1, outline:'none', fontFamily:'monospace' }} />
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                {btn('Prev', onPrev, current === 1)}
                <span style={{ fontSize:12, fontFamily:'monospace', color:T.txt2, padding:'0 4px' }}><span style={{ color:T.txt1, fontWeight:700 }}>{current}</span><span style={{ color:T.txt3 }}> / {total}</span></span>
                {btn('Next', onNext, current === total)}
            </div>
        </div>
    );
};

const hoverBorderButtonProps = (baseColor = T.txt3, hoverColor = T.txt1, hoverBorder = T.borderHi, hoverBackground = T.raised) => ({
    onMouseEnter: e => {
        e.currentTarget.style.color = hoverColor;
        e.currentTarget.style.borderColor = hoverBorder;
        e.currentTarget.style.background = hoverBackground;
    },
    onMouseLeave: e => {
        e.currentTarget.style.color = baseColor;
        e.currentTarget.style.borderColor = T.border;
        e.currentTarget.style.background = 'transparent';
    },
});

const Dashboard = () => {
    const [alerts, setAlerts] = useState([]);
    const [logs, setLogs] = useState([]);
    const [uploadedFiles, setUploadedFiles] = useState([]);
    const [availableDatasets, setAvailableDatasets] = useState([]);
    const [activeDataset, setActiveDataset] = useState('ALL');
    const [loading, setLoading] = useState(true);
    const [isUploading, setIsUploading] = useState(false);
    const [engineStatus, setEngineStatus] = useState('Idle');
    const [uploadStartedAt, setUploadStartedAt] = useState(null);
    const [uploadFileName, setUploadFileName] = useState('');
    const [uploadElapsedSeconds, setUploadElapsedSeconds] = useState(0);
    const [currentRole, setCurrentRole] = useState('Analyst');
    const [activeTab, setActiveTab] = useState('ALL');
    const [activeLogTab, setActiveLogTab] = useState('ALL');
    const [searchTerm, setSearchTerm] = useState('');
    const [searchType, setSearchType] = useState('ACCOUNT_ID');
    const [jumpPage, setJumpPage] = useState('');
    const [selectedAccount, setSelectedAccount] = useState(null);
    const [uploadLimitEnabled, setUploadLimitEnabled] = useState(true);
    const [maxUploadMB, setMaxUploadMB] = useState(100);
    const [perUploadMB, setPerUploadMB] = useState(100);
    const [currentPage, setCurrentPage] = useState(1);
    const [resolvedIds, setResolvedIds] = useState(new Set());
    const [totalAlertsCount, setTotalAlertsCount] = useState(0);
    const [modelConfig, setModelConfig] = useState(null);
    const [inputSchema, setInputSchema] = useState(null);
    const [modelMetrics, setModelMetrics] = useState(null);
    const [thresholdCurve, setThresholdCurve] = useState([]);
    const [featureImportance, setFeatureImportance] = useState([]);
    const [selectedSampleDataset, setSelectedSampleDataset] = useState(sampleDatasets[0]);
    const [datasetSourceFilter, setDatasetSourceFilter] = useState('ALL');
    const itemsPerPage = 12;
    const fileInputRef = useRef(null);
    const statusInterval = useRef(null);
    const socketRefLocal = useRef(null);

    const statusMeta = getUploadStatusMeta(engineStatus);

    useEffect(() => {
        if (!isUploading || !uploadStartedAt) {
            setTimeout(() => setUploadElapsedSeconds(0), 0);
            return undefined;
        }

        const timer = setInterval(() => {
            setUploadElapsedSeconds(Math.floor((Date.now() - uploadStartedAt) / 1000));
        }, 1000);

        return () => clearInterval(timer);
    }, [isUploading, uploadStartedAt]);

    const fetchJson = async (endpoint, init) => {
        const response = await fetch(`${API_BASE}${endpoint}`, init);
        if (!response.ok) return null;
        return response.json();
    };

    const fetchAlerts = React.useCallback(async (page = 1, opts = {}) => {
        try {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', String(itemsPerPage));
            if (opts.dataset && opts.dataset !== 'ALL') params.set('dataset', opts.dataset);
            if (opts.status && opts.status !== 'ALL') params.set('status', opts.status);
            if (opts.search && String(opts.search).trim()) params.set('search', String(opts.search).trim());

            const data = await fetchJson(`/api/alerts?${params.toString()}`);
            if (data) {
                setAlerts(data.data || []);
                setTotalAlertsCount(Number(data.total || data.count || (data.data || []).length));
            }
        } catch {
            /* ignore */
        }
    }, [itemsPerPage]);

    const fetchDatasets = async () => {
        try {
            const data = await fetchJson('/api/files');
            if (data) setAvailableDatasets(data.data || []);
        } catch {
            /* ignore */
        }
    };

    const fetchModelConfig = async () => {
        try {
            const data = await fetchJson('/api/config');
            if (data) {
                setModelConfig(data.thresholds || null);
                setInputSchema(data.inputSchema || null);
                setModelMetrics(data.modelMetrics || null);
                setThresholdCurve(data.thresholdCurve || []);
                setFeatureImportance(data.featureImportance || []);
            }
        } catch {
            /* ignore */
        }
    };

    const fetchLogsAndFiles = async () => {
        try {
            const [logsData, filesData] = await Promise.all([fetchJson('/api/logs'), fetchJson('/api/files')]);
            if (logsData) setLogs(logsData.data || []);
            if (filesData) {
                setUploadedFiles(filesData.data || []);
                setAvailableDatasets(filesData.data || []);
            }
        } catch {
            /* ignore */
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        const socket = io(API_BASE);
        const alarm = new Audio('/siren.mp3');

        socket.on('SCAN_COMPLETE', (data) => {
            alarm.play().catch(() => {});
            toast.custom(() => (
                <div style={{ background:T.raised, border:`1px solid ${T.critBdr}`, borderRadius:8, padding:'14px 16px', display:'flex', gap:12, alignItems:'flex-start', boxShadow:'0 4px 24px rgba(0,0,0,0.4)', maxWidth:360 }}>
                    <div style={{ width:32, height:32, borderRadius:'50%', background:T.critBg, border:`1px solid ${T.critBdr}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <svg width="16" height="16" fill="none" stroke={T.crit} strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    </div>
                    <div>
                        <p style={{ fontSize:11, fontWeight:700, color:T.crit, letterSpacing:'0.08em', marginBottom:4 }}>SCAN COMPLETE</p>
                        <p style={{ fontSize:12, color:T.txt1, fontFamily:'monospace', marginBottom:2 }}>{data.fileName}</p>
                        <p style={{ fontSize:11, color:T.txt2 }}>{data.criticalCount} Critical · {data.highRiskCount} High Risk</p>
                    </div>
                </div>
            ), { duration:8000, position:'top-right' });
        });

        socket.on('SILENT_REFRESH', () => { setTimeout(() => { fetchAlerts(currentPage, { dataset: activeDataset, status: activeTab, search: searchTerm }); fetchDatasets(); fetchLogsAndFiles(); }, 0); });
        socket.on('NEW_LOG', (l) => setLogs(prev => [l, ...prev]));
        socket.on('SYNC_STATE', (state) => {
            try {
                if (state.alerts) setAlerts(state.alerts || []);
                if (state.files) { setUploadedFiles(state.files || []); setAvailableDatasets(state.files || []); }
                if (state.logs) setLogs(state.logs || []);
                if (state.config && state.config.thresholds) setModelConfig(state.config.thresholds);
            } catch {
                /* ignore */
            }
        });
        socket.on('ENGINE_PROGRESS', (payload) => {
            try {
                if (payload && payload.status) {
                    setEngineStatus(payload.status);
                    const terminal = ['Complete', 'Duplicate Rejected', 'Engine Failure', 'Database Error'];
                    if (terminal.includes(payload.status)) {
                        setIsUploading(false);
                        if (statusInterval.current) { clearInterval(statusInterval.current); statusInterval.current = null; }
                        setTimeout(() => { fetchAlerts(currentPage); fetchDatasets(); fetchLogsAndFiles(); fetchModelConfig(); }, 0);
                    }
                }
            } catch {
                /* ignore */
            }
        });

        setTimeout(() => { fetchAlerts(currentPage, { dataset: activeDataset, status: activeTab, search: searchTerm }); fetchDatasets(); fetchLogsAndFiles(); fetchModelConfig(); }, 0);
        socketRefLocal.current = socket;
        return () => { socket.disconnect(); socketRefLocal.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const r = await fetch(`${API_BASE}/api/upload-config`);
                if (!r.ok) return;
                const j = await r.json();
                if (j && j.success) {
                    setMaxUploadMB(Number(j.maxUploadMB || 0));
                    setUploadLimitEnabled(Boolean(j.enabled));
                    setPerUploadMB(Number(j.maxUploadMB || 0));
                }
            } catch {
                /* ignore */
            }
        })();
    }, []);

    useEffect(() => { setTimeout(() => setCurrentPage(1), 0); }, [activeTab, searchTerm, searchType, activeLogTab, activeDataset, datasetSourceFilter]);

    useEffect(() => {
        setTimeout(() => { fetchAlerts(currentPage, { dataset: activeDataset, status: activeTab, search: searchTerm }); }, 0);
    }, [currentPage, activeDataset, activeTab, searchTerm, fetchAlerts]);

    const startStatusTracking = () => {
        if (socketRefLocal.current) return;
        const terminalStatuses = new Set(['Complete', 'Duplicate Rejected', 'Engine Failure', 'Database Error']);
        if (statusInterval.current) clearInterval(statusInterval.current);
        statusInterval.current = setInterval(async () => {
            try {
                const data = await fetchJson('/api/status');
                if (data) {
                    setEngineStatus(data.status);
                    if (terminalStatuses.has(data.status)) {
                        clearInterval(statusInterval.current);
                        statusInterval.current = null;
                        setIsUploading(false);
                        setUploadStartedAt(null);
                        setTimeout(() => { fetchAlerts(currentPage); fetchDatasets(); fetchLogsAndFiles(); fetchModelConfig(); }, 0);
                    }
                }
            } catch {
                /* ignore */
            }
        }, 2000);
    };

    const handleSystemWipe = async () => {
        if (!window.confirm('WARNING: This will delete all alerts, file histories, and logs from MongoDB. Proceed?')) return;
        try {
            await fetchJson('/api/system-wipe', { method:'DELETE' });
            setAlerts([]);
            setUploadedFiles([]);
            setAvailableDatasets([]);
            setActiveDataset('ALL');
            setResolvedIds(new Set());
            toast.success('System wiped. Ready for fresh uploads.', { style:{ background:T.raised, color:T.ok, border:`1px solid #163028` } });
        } catch {
            alert('Failed to wipe system');
        }
    };

    const handleFileUpload = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        setIsUploading(true);
        setEngineStatus('Uploading file...');
        setUploadFileName(file.name);
        setUploadStartedAt(Date.now());
        setUploadElapsedSeconds(0);
        startStatusTracking();
        const uploadToastId = toast.loading(`Uploading ${file.name} and verifying the dataset hash...`, { style:{ background:T.raised, color:T.txt1, border:`1px solid ${T.borderHi}` } });
        const fd = new FormData();
        fd.append('telemetryFile', file);
        try {
            const qp = perUploadMB ? `?max_upload_mb=${encodeURIComponent(Number(perUploadMB))}` : '';
            const res = await fetch(`${API_BASE}/api/upload${qp}`, { method:'POST', body:fd });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.message || 'Failed to process CSV');
            }
            toast.success(`Uploaded ${file.name}.`, { id: uploadToastId, style:{ background:T.raised, color:T.ok, border:`1px solid #163028` }, duration:6000 });
        } catch (e) {
            console.error(e);
            toast.error('Failed to upload file.', { id: uploadToastId, style:{ background:T.raised, color:T.crit, border:`1px solid ${T.critBdr}` }, duration:6000 });
        } finally {
            event.target.value = '';
        }
    };

    const saveUploadConfig = async () => {
        try {
            const body = { maxUploadMB: uploadLimitEnabled ? Number(maxUploadMB) : null, enabled: uploadLimitEnabled };
            const r = await fetch(`${API_BASE}/api/upload-config`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
            const j = await r.json();
            if (r.ok && j && j.success) toast.success('Upload configuration saved.');
            else toast.error('Failed to save upload configuration.');
        } catch (e) {
            console.error(e);
            toast.error('Failed to save upload configuration.');
        }
    };

    const handleResolve = async (accountId, e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        setResolvedIds(prev => new Set(prev).add(accountId));
        try {
            await fetchJson('/api/resolve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ accountId, decision:'SAFE', sourceFileName: selectedAccount?.sourceFileName || null }) });
            toast.success(`${accountId} marked as safe.`, { style:{ background:T.raised, color:T.ok, border:`1px solid #163028` } });
        } catch (err) {
            console.error(err);
            toast.error('Failed to mark safe.');
        }
    };

    const confirmMule = async (alertId) => {
        try {
            await fetchJson(`/api/alerts/${alertId}/mule`, { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ muleStatus: 'Confirmed Mule' }) });
            toast.success('Mule status updated.');
        } catch (error) {
            console.error(error);
            toast.error('Failed to update mule status.');
        }
    };

    const exportToCSV = () => {
        const rows = activeAlerts.map(a => {
            const features = getAlertFeatures(a);
            const explanation = features.map(f => `${f.name}:${String(f.contribution ?? 0)}`).join(' | ');
            return `${a.accountId},${a.riskScore},${a.anomalyScore},${a.status},"${explanation}",${a.sourceFileName}`;
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['Account ID,Risk Score,Anomaly Score,Status,Top Features,Source File\n' + rows.join('\n')], { type:'text/csv' }));
        a.download = `Nexus_${activeDataset === 'ALL' ? 'Global' : activeDataset}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
    };

    const resolveSourceType = (file) => file?.sourceType || (String(file?.fileName || '').startsWith('LIVE_STREAM_') ? 'LIVE_STREAM' : 'STATIC_INGEST');
    const visibleDatasetFiles = useMemo(() => availableDatasets.filter(file => datasetSourceFilter === 'ALL' || resolveSourceType(file) === datasetSourceFilter), [availableDatasets, datasetSourceFilter]);
    const visibleDatasetNames = useMemo(() => new Set(visibleDatasetFiles.map(file => file.fileName)), [visibleDatasetFiles]);
    const unresolvedAlerts = useMemo(() => alerts.filter(a => !resolvedIds.has(a.accountId)), [alerts, resolvedIds]);
    const activeAlerts = useMemo(() => unresolvedAlerts.filter(a => {
        const matchesDataset = activeDataset === 'ALL' || a.sourceFileName === activeDataset;
        const matchesSource = datasetSourceFilter === 'ALL' || visibleDatasetNames.has(a.sourceFileName);
        return matchesDataset && matchesSource;
    }), [unresolvedAlerts, activeDataset, datasetSourceFilter, visibleDatasetNames]);
    const filteredAlerts = useMemo(() => activeAlerts.filter(a => {
        const tab = activeTab === 'ALL' || (activeTab === 'CRITICAL' && a.status === 'Critical') || (activeTab === 'HIGH_RISK' && a.status === 'High Risk');
        const search = !searchTerm ? true : searchType === 'ACCOUNT_ID'
            ? a.accountId.toLowerCase().includes(searchTerm.toLowerCase())
            : getAlertFeatures(a).some(fObj => {
                const fname = fObj.name;
                return fname.toLowerCase().includes(searchTerm.toLowerCase()) || translate(fname).toLowerCase().includes(searchTerm.toLowerCase());
            });
        return tab && search;
    }), [activeAlerts, activeTab, searchTerm, searchType]);
    const totalPages = Math.max(1, Math.ceil(totalAlertsCount / itemsPerPage));
    const currentAlerts = filteredAlerts;
    const idx0 = (currentPage - 1) * itemsPerPage;
    const filteredLogs = logs.filter(l => activeLogTab === 'ALL' || l.actor === activeLogTab);
    const totalLogPages = Math.ceil(filteredLogs.length / itemsPerPage);
    const currentLogs = filteredLogs.slice(idx0, idx0 + itemsPerPage);
    const handleJumpKey = (e, total) => {
        if (e.key !== 'Enter') return;
        const n = parseInt(jumpPage, 10);
        if (!isNaN(n) && n >= 1 && n <= total) setCurrentPage(n);
        setJumpPage('');
    };
    const critCount = new Set(activeAlerts.filter(a => a.status === 'Critical').map(a => a.accountId)).size;
    const highCount = new Set(activeAlerts.filter(a => a.status === 'High Risk').map(a => a.accountId)).size;
    const baseScanned = activeDataset === 'ALL'
        ? visibleDatasetFiles.reduce((s, f) => s + (f.totalAccountsScanned || 0), 0)
        : visibleDatasetFiles.find(f => f.fileName === activeDataset)?.totalAccountsScanned || 0;
    const totalScanned = Math.max(baseScanned, critCount + highCount);
    const riskData = [{ name:'Critical', value:critCount }, { name:'High Risk', value:highCount }];
    const featureCounts = useMemo(() => {
        const counts = {};
        activeAlerts.forEach(a => getAlertFeatures(a).forEach(fObj => {
            const f = fObj.name;
            counts[f] = (counts[f] || 0) + 1;
        }));
        return counts;
    }, [activeAlerts]);
    const featureData = useMemo(() => Object.keys(featureCounts).map(k => ({ name: k === 'Anomaly_Score' ? 'STAT' : k, count: featureCounts[k], fullName: translate(k) })).sort((a, b) => b.count - a.count).slice(0, 6), [featureCounts]);
    const inputSchemaLabel = inputSchema?.type === 'transaction_graph' ? 'Transaction Graph' : inputSchema?.type === 'wide_table' ? 'Wide Table' : (inputSchema?.type || 'Legacy Table');

    const openLiveRoute = (path) => {
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
    };

    if (loading) return (
        <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:T.bg }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
                <div style={{ width:36, height:36, border:`2px solid ${T.border}`, borderTop:`2px solid ${T.accent}`,
                    borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
                <p style={{ fontSize:12, color:T.txt3, fontFamily:'monospace', letterSpacing:'0.15em', textTransform:'uppercase' }}>
                    Initializing Nexus Core
                </p>
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );

        const statusText = isUploading || statusMeta.kind !== 'idle' ? statusMeta.label : 'Engine Idle';
        const statusTone = statusMeta.kind === 'error' ? T.crit : statusMeta.kind === 'done' ? T.ok : isUploading ? T.accent : T.ok;

        const RoleNavigationBar = () => (
            <header style={{ height:60, display:'flex', alignItems:'center', justifyContent:'space-between', gap:14, padding:'0 20px', borderBottom:`1px solid ${T.border}`,
                background: currentRole === 'Admin' ? `linear-gradient(135deg, ${T.accentBg} 0%, ${T.surface} 100%)` : `linear-gradient(135deg, ${T.raised} 0%, ${T.surface} 100%)`, flexShrink:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <div style={{ width:30, height:30, borderRadius:8, background:T.accentBg, border:`1px solid ${T.accent}30`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <svg width="15" height="15" fill="none" stroke={T.accent} strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                    </div>
                    <div>
                        <div style={{ fontSize:13, fontWeight:800, color:T.txt1 }}>Project Nexus</div>
                        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em' }}>{currentRole === 'Admin' ? 'Administrator Workspace' : 'Analyst Workspace'}</div>
                    </div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', justifyContent:'flex-end' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', borderRadius:999, background:T.bg, border:`1px solid ${T.borderHi}` }}>
                        <span style={{ fontSize:11, color:T.txt3 }}>Role</span>
                        <select value={currentRole} onChange={e => setCurrentRole(e.target.value)} style={{ padding:'6px 8px', borderRadius:6, border:`1px solid ${T.borderHi}`, background:T.raised, color:T.txt1, fontSize:12 }}>
                            <option value="Analyst">Analyst</option>
                            <option value="Admin">Administrator</option>
                        </select>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 12px', background:T.critBg, border:`1px solid ${T.critBdr}`, borderRadius:999 }}>
                        <span style={{ width:6, height:6, borderRadius:'50%', background:T.crit, flexShrink:0 }} />
                        <span style={{ fontSize:12, color:T.crit, fontWeight:700 }}>{critCount} Critical</span>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 12px', background:T.highBg, border:`1px solid ${T.highBdr}`, borderRadius:999 }}>
                        <span style={{ width:6, height:6, borderRadius:'50%', background:T.high, flexShrink:0 }} />
                        <span style={{ fontSize:12, color:T.high, fontWeight:700 }}>{highCount} High Risk</span>
                    </div>
                </div>
            </header>
        );

        const AnalystWorkspace = () => {
            const resolvedCount = resolvedIds.size;
            const visibleAlerts = currentAlerts;

            return (
                <div style={{ flex:1, overflowY:'auto', padding:20 }}>
                    <Card style={{ padding:'16px 18px', marginBottom:14, border:`1px solid ${T.borderHi}`, background:`linear-gradient(135deg, ${T.raised} 0%, #121419 100%)` }}>
                        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:14, flexWrap:'wrap' }}>
                            <div>
                                <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:6 }}>Threat Matrix</div>
                                <div style={{ fontSize:22, fontWeight:800, color:T.txt1 }}>Case review first, fast action second.</div>
                                <div style={{ fontSize:12, color:T.txt2, marginTop:6, lineHeight:1.6 }}>Inspect accounts, mark safe, and confirm mule status without the analytics overhead.</div>
                            </div>
                            <button onClick={() => fileInputRef.current.click()} style={{ padding:'10px 14px', borderRadius:8, border:`1px solid ${T.borderHi}`, background:T.surface, color:T.txt1, fontSize:12, fontWeight:700, cursor:'pointer' }}>Ingest Data</button>
                        </div>
                    </Card>

                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12, marginBottom:14 }}>
                        <MetricCard label="Critical Threats" value={critCount} color={T.crit} />
                        <MetricCard label="High Risk" value={highCount} color={T.high} />
                        <MetricCard label="Alerts Resolved" value={resolvedCount} color={T.ok} />
                    </div>

                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:12 }}>
                        <div style={{ display:'flex', background:T.surface, border:`1px solid ${T.border}`, borderRadius:6, padding:3, gap:2 }}>
                            {[['ALL','All'],['CRITICAL','Critical'],['HIGH_RISK','High Risk']].map(([id,label]) => (
                                <button key={id} onClick={() => setActiveTab(id)} style={{ padding:'5px 14px', fontSize:12, fontWeight:600, borderRadius:4, border:'none', cursor:'pointer', background: activeTab === id ? T.raised : 'transparent', color: activeTab === id ? (id === 'CRITICAL' ? T.crit : id === 'HIGH_RISK' ? T.high : T.txt1) : T.txt3 }}>{label}</button>
                            ))}
                        </div>
                        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                            <div style={{ display:'flex', background:T.surface, border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden' }}>
                                <select value={searchType} onChange={e => setSearchType(e.target.value)} style={{ padding:'6px 10px', fontSize:11, background:T.raised, border:'none', borderRight:`1px solid ${T.border}`, color:T.txt2, outline:'none', cursor:'pointer', fontWeight:600 }}>
                                    <option value="ACCOUNT_ID">ACCT ID</option>
                                    <option value="FEATURE">FEATURE</option>
                                </select>
                                <input type="text" placeholder="Searchâ€¦" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={{ padding:'6px 12px', fontSize:13, background:'transparent', border:'none', color:T.txt1, outline:'none', width:180 }} />
                            </div>
                            <button onClick={exportToCSV} style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:6, cursor:'pointer', background:T.surface, border:`1px solid ${T.border}`, color:T.txt2 }} {...hoverBorderButtonProps(T.txt2)}><svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>Export CSV</button>
                        </div>
                    </div>

                    <div style={{ fontSize:12, color:T.txt3, marginBottom:8 }}><span style={{ color:T.txt1, fontWeight:600 }}>{filteredAlerts.length}</span> threats Â· page <span style={{ color:T.txt1 }}>{currentPage}</span> of {totalPages || 1}</div>

                    <Card>
                        <table style={{ width:'100%', borderCollapse:'collapse' }}>
                            <thead><tr><TH>Account ID</TH><TH>Status</TH><TH>Risk Score</TH><TH>SHAP Explainability (Why?)</TH><TH>Dataset</TH><TH right>Actions</TH></tr></thead>
                            <tbody>
                                {visibleAlerts.length > 0 ? visibleAlerts.map((alert, i) => {
                                    const isCrit = alert.status === 'Critical';
                                    return (
                                        <tr key={i} onClick={() => setSelectedAccount(alert)} style={{ borderBottom:`1px solid ${T.border}`, cursor:'pointer', borderLeft:`3px solid ${isCrit ? T.crit : T.high}` }} onMouseEnter={e => e.currentTarget.style.background = T.raised} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                            <td style={{ padding:'11px 16px' }}><div style={{ fontFamily:'monospace', fontSize:13, fontWeight:600, color:T.txt1 }}>{alert.accountId}</div></td>
                                            <td style={{ padding:'11px 16px' }}><div style={{ display:'flex', alignItems:'center', gap:8 }}><StatusChip status={alert.status} /><MuleStatusBadge status={alert.muleStatus || 'Pending'} /></div></td>
                                            <td style={{ padding:'11px 16px', minWidth:110 }}><div style={{ fontSize:15, fontWeight:700, fontFamily:'monospace', color: isCrit ? T.crit : T.high }}>{alert.riskScore.toFixed(1)}%</div><RiskBar score={alert.riskScore} status={alert.status} /><div style={{ fontSize:11, color:T.txt3, marginTop:5, fontFamily:'monospace' }}>Anomaly: {alert.anomalyScore}</div></td>
                                            <td style={{ padding:'11px 16px' }}><div style={{ display:'flex', flexDirection:'column', gap:6 }}>{getAlertFeatures(alert).map((fObj, idx) => { const f = fObj.name; const cat = featureCat(f); const contribution = Number(fObj.contribution || 0); const isPos = contribution > 0; const isNeg = contribution < 0; return (<div key={f + idx} style={{ display:'flex', alignItems:'center', gap:8 }}><span style={{ fontSize:10, fontFamily:'monospace', fontWeight:700, color:cat.color, background:cat.bg, border:`1px solid ${cat.border}`, padding:'1px 7px', borderRadius:3, flexShrink:0, minWidth:52, textAlign:'center' }}>{f === 'Anomaly_Score' ? 'STAT' : f}</span><div style={{ display:'flex', flexDirection:'column' }}><span style={{ fontSize:12, color:T.txt1 }}>{translate(f)}</span>{fObj.contribution !== null && (<span style={{ fontSize:10, color: isPos ? T.crit : isNeg ? T.ok : T.txt3, fontWeight:600, display:'flex', alignItems:'center', gap:4, marginTop:1 }}>{isPos ? 'â–² Increased Risk' : isNeg ? 'â–¼ Decreased Risk' : 'â€¢ Neutral Impact'}<span style={{ color:T.txt3, fontWeight:400 }}>(SHAP {isPos?'+':''}{Number.isFinite(contribution) ? String(contribution) : '0'})</span></span>)}</div></div>); })}</div></td>
                                            <TD muted>{alert.sourceFileName}</TD>
                                            <td style={{ padding:'11px 16px', textAlign:'right' }}><div style={{ display:'flex', gap:6, justifyContent:'flex-end', alignItems:'center' }}><button onClick={e => handleResolve(alert.accountId, e)} title="Mark as Safe" style={{ padding:'5px 10px', fontSize:11, fontWeight:600, borderRadius:5, background:'transparent', border:`1px solid ${T.border}`, color:T.txt3, cursor:'pointer' }} {...hoverBorderButtonProps(T.txt3, T.ok, '#163028', T.okBg)}>Safe</button><button onClick={e => { e.stopPropagation(); e.preventDefault(); confirmMule(alert._id); }} title="Confirm Mule" style={{ padding:'5px 10px', fontSize:11, fontWeight:600, borderRadius:5, background:T.critBg, border:`1px solid ${T.critBdr}`, color:T.crit, cursor:'pointer' }} {...hoverBorderButtonProps(T.crit, '#fff', T.critBdr, T.critBg)}>Confirm Mule</button><button onClick={e => { e.stopPropagation(); setSelectedAccount(alert); }} style={{ padding:'5px 12px', fontSize:11, fontWeight:600, borderRadius:5, background:T.accentBg, border:`1px solid ${T.accent}30`, color:T.accent, cursor:'pointer' }} {...hoverBorderButtonProps(T.accent, '#fff', T.accent, T.accent)}>Inspect</button></div></td>
                                        </tr>
                                    );
                                }) : <tr><td colSpan="6" style={{ padding:'40px 16px', textAlign:'center', color:T.txt3, fontSize:12, fontFamily:'monospace', letterSpacing:'0.08em' }}>NO THREATS MATCH CURRENT FILTER</td></tr>}
                            </tbody>
                        </table>
                        <Pagination current={currentPage} total={totalPages} jumpPage={jumpPage} onJumpChange={e => setJumpPage(e.target.value)} onJumpKey={e => handleJumpKey(e, totalPages)} onPrev={() => setCurrentPage(p => Math.max(1,p-1))} onNext={() => setCurrentPage(p => Math.min(totalPages,p+1))} />
                    </Card>

                    {selectedAccount && (
                        <div style={{ position:'fixed', inset:0, zIndex:50, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.7)', backdropFilter:'blur(4px)', padding:16 }}>
                            <div style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:10, width:'100%', maxWidth:900, maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }}>
                                <div style={{ padding:'16px 20px', borderBottom:`1px solid ${T.border}`, display:'flex', justifyContent:'space-between', alignItems:'center', background:T.raised, flexShrink:0 }}>
                                    <div style={{ display:'flex', alignItems:'center', gap:20 }}><RiskGauge score={selectedAccount.riskScore} status={selectedAccount.status} /><div><div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Account Inspection</div><div style={{ fontSize:20, fontWeight:700, fontFamily:'monospace', color:T.txt1, letterSpacing:'0.04em' }}>{selectedAccount.accountId}</div><div style={{ display:'flex', gap:16, marginTop:6 }}><span style={{ fontSize:11, color:T.txt3, fontFamily:'monospace' }}>{new Date(selectedAccount.detectedAt).toLocaleString()}</span><span style={{ fontSize:11, color:T.txt3, fontFamily:'monospace' }}>{selectedAccount.sourceFileName}</span></div></div></div>
                                    <div style={{ display:'flex', gap:8 }}><button onClick={(e) => { handleResolve(selectedAccount.accountId, e); setSelectedAccount(null); }} style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', fontSize:12, fontWeight:600, borderRadius:6, cursor:'pointer', background:T.okBg, border:`1px solid #163028`, color:T.ok }}>Mark Safe</button><button onClick={() => setSelectedAccount(null)} style={{ padding:'7px 10px', borderRadius:6, background:'transparent', border:`1px solid ${T.border}`, color:T.txt3, cursor:'pointer' }} {...hoverBorderButtonProps(T.txt3)}><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button></div>
                                </div>
                                <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
                                    <div style={{ width:'55%', padding:20, overflowY:'auto', borderRight:`1px solid ${T.border}` }}>
                                        <div style={{ fontSize:10, fontWeight:700, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:14 }}>KYC Profile &amp; Ledger</div>
                                        {selectedAccount.kycData ? (<><div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:18 }}>{[{ label:'Account Holder', val:selectedAccount.kycData.fullName, color:T.txt1 },{ label:'Current Balance', val:selectedAccount.kycData.currentBalance, color:T.ok },{ label:'Last Login IP', val:selectedAccount.kycData.lastLoginIp, color:T.txt2 },{ label:'Device Fingerprint', val:selectedAccount.kycData.deviceType, color:T.txt2 }].map(({ label, val, color }) => (<div key={label} style={{ background:T.raised, border:`1px solid ${T.border}`, borderRadius:6, padding:'12px 14px' }}><div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:5 }}>{label}</div><div style={{ fontSize:13, fontWeight:600, color, fontFamily: label.includes('IP')||label.includes('Device') ? 'monospace' : 'inherit' }}>{val}</div></div>))}</div><div style={{ fontSize:10, fontWeight:700, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:10 }}>Recent Transactions (72h)</div><table style={{ width:'100%', borderCollapse:'collapse', background:T.raised, border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden' }}><thead><tr style={{ background:T.bg }}>{['TXN ID','Type','Amount'].map((h,i) => (<th key={h} style={{ padding:'8px 12px', fontSize:10, color:T.txt3, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', textAlign: i === 2 ? 'right' : 'left', borderBottom:`1px solid ${T.border}` }}>{h}</th>))}</tr></thead><tbody>{selectedAccount.kycData.recentTransactions.map((txn, i) => (<tr key={i} style={{ borderBottom:`1px solid ${T.border}` }}><td style={{ padding:'9px 12px', fontFamily:'monospace', fontSize:11, color:T.accent }}>{txn.txnId}</td><td style={{ padding:'9px 12px', fontSize:12, color:T.txt2 }}>{txn.type}</td><td style={{ padding:'9px 12px', fontFamily:'monospace', fontSize:12, color:T.txt1, fontWeight:600, textAlign:'right' }}>{txn.amount}</td></tr>))}</tbody></table></>) : <div style={{ color:T.txt3, fontSize:13, fontStyle:'italic' }}>KYC data unavailable.</div>}
                                    </div>
                                    <div style={{ width:'45%', padding:20, overflowY:'auto', background:T.bg }}>
                                        <div style={{ fontSize:10, fontWeight:700, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:14 }}>AI Telemetry â€” Active Signals</div>
                                        {selectedAccount.rawTelemetry ? (<div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>{Object.entries(selectedAccount.rawTelemetry).filter(([k,v]) => k !== 'Anomaly_Score' && v !== 0).map(([k, v]) => { const topF = getAlertFeatures(selectedAccount).find(tf => tf.name === k); const isTop = !!topF; const cat = featureCat(k); return (<div key={k} style={{ background: isTop ? cat.bg : T.surface, border: `1px solid ${isTop ? cat.border : T.border}`, borderLeft: isTop ? `3px solid ${cat.color}` : `1px solid ${T.border}`, borderRadius:6, padding:'10px 12px' }}><div style={{ fontSize:10, fontFamily:'monospace', color: isTop ? cat.color : T.txt3, marginBottom:3 }}>{k}</div><div style={{ fontSize:15, fontWeight:700, fontFamily:'monospace', color: isTop ? cat.color : T.txt1 }}>{Number.isInteger(v) ? v : Number(v).toFixed(4)}</div>{isTop && topF.contribution !== null && (<div style={{ fontSize:10, color: topF.contribution > 0 ? T.crit : topF.contribution < 0 ? T.ok : T.txt3, fontWeight:600, marginTop:6, display:'flex', alignItems:'center', gap:3 }}>{topF.contribution > 0 ? 'â–² Risk UP' : topF.contribution < 0 ? 'â–¼ Risk DOWN' : 'â€¢ Neutral Impact'}<span style={{color:T.txt3, fontWeight:400}}>(SHAP {topF.contribution > 0 ? '+' : ''}{String(topF.contribution)})</span></div>)}{featureDictionary[k] && (<div style={{ fontSize:10, color:T.txt3, marginTop: isTop ? 4 : 8, lineHeight:1.4 }}>{featureDictionary[k]}</div>)}</div>); })}</div>) : <div style={{ textAlign:'center', padding:32, color:T.txt3, fontFamily:'monospace', fontSize:12 }}>Raw telemetry unavailable.</div>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            );
        };

        const AdminWorkspace = () => (
            <div style={{ flex:1, overflowY:'auto', padding:20 }}>
                <Card style={{ padding:'20px 22px', marginBottom:16, background:`linear-gradient(135deg, ${T.raised} 0%, #17191f 45%, #111214 100%)`, border:`1px solid ${T.borderHi}` }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:18, flexWrap:'wrap', alignItems:'flex-start' }}>
                        <div style={{ maxWidth:620 }}>
                            <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:8 }}>Dataset Lab</div>
                            <h2 style={{ margin:'0 0 8px 0', fontSize:28, lineHeight:1.08, color:T.txt1, letterSpacing:'-0.03em' }}>Aggregate analytics, config, and operations in one view.</h2>
                            <p style={{ margin:0, color:T.txt2, fontSize:13, lineHeight:1.6, maxWidth:540 }}>Use a classic wide-table CSV, a transaction edge list, or a graph benchmark to validate feature engineering, SHAP explainability, and thresholding before you upload production data.</p>
                            <div style={{ display:'flex', gap:10, marginTop:16, flexWrap:'wrap' }}>
                                <button onClick={() => fileInputRef.current.click()} style={{ padding:'10px 16px', borderRadius:8, border:`1px solid ${T.accent}`, background:T.accent, color:'#fff', fontSize:12, fontWeight:700, cursor:'pointer' }}>Upload CSV</button>
                                <button onClick={() => openLiveRoute('/live-stream')} style={{ padding:'10px 16px', borderRadius:8, border:`1px solid ${T.borderHi}`, background:T.bg, color:T.txt1, fontSize:12, fontWeight:700, cursor:'pointer' }}>Live Stream Connector</button>
                            </div>
                        </div>
                        <div style={{ minWidth:210, padding:'14px 16px', borderRadius:12, background:T.bg, border:`1px solid ${T.border}` }}>
                            <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:8 }}>Current Schema</div>
                            <div style={{ fontSize:20, fontWeight:700, color:T.txt1, marginBottom:6 }}>{inputSchemaLabel}</div>
                            <div style={{ fontSize:12, color:T.txt2, lineHeight:1.5 }}>{inputSchema?.type === 'transaction_graph' ? 'Source and destination accounts are aggregated into node-level risk features.' : 'The model is using the legacy wide-table account schema.'}</div>
                        </div>
                    </div>
                </Card>

                <Card style={{ padding:'18px 20px', marginBottom:16 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:14, flexWrap:'wrap', marginBottom:14 }}>
                        <div>
                            <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6 }}>Overview</div>
                            <div style={{ fontSize:18, fontWeight:700, color:T.txt1 }}>Upload settings and dataset selection</div>
                            <div style={{ fontSize:12, color:T.txt2, marginTop:6, lineHeight:1.5 }}>Admins care about aggregate performance and operational controls.</div>
                        </div>
                        <div style={{ padding:'10px 12px', borderRadius:8, background:T.bg, border:`1px solid ${T.border}` }}>
                            <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Upload Configuration</div>
                            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                                <label style={{ fontSize:12, color:T.txt2, display:'flex', alignItems:'center', gap:8 }}><input type="checkbox" checked={uploadLimitEnabled} onChange={e => setUploadLimitEnabled(e.target.checked)} /><span>Limit uploads</span></label>
                                <input type="number" min={1} value={maxUploadMB} onChange={e => setMaxUploadMB(e.target.value)} style={{ width:86, padding:'6px 8px', borderRadius:6, border:`1px solid ${T.borderHi}`, background:T.bg, color:T.txt1 }} />
                                <button onClick={saveUploadConfig} style={{ padding:'8px 10px', borderRadius:6, border:`1px solid ${T.borderHi}`, background:T.surface, color:T.txt1, cursor:'pointer' }}>Save</button>
                                <span style={{ fontSize:12, color:T.txt2 }}>Per-upload MB</span>
                                <input type="number" min={1} value={perUploadMB} onChange={e => setPerUploadMB(e.target.value)} style={{ width:86, padding:'6px 8px', borderRadius:6, border:`1px solid ${T.borderHi}`, background:T.bg, color:T.txt1 }} />
                            </div>
                        </div>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:10 }}>
                        <div style={{ padding:'12px 14px', borderRadius:10, background:T.bg, border:`1px solid ${T.border}` }}>
                            <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:8 }}>Sample Dataset Menu</div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'center' }}>
                                <select value={selectedSampleDataset.name} onChange={e => { const ds = sampleDatasets.find(d => d.name === e.target.value) || sampleDatasets[0]; setSelectedSampleDataset(ds); let schemaType = 'wide_table'; if (/graph/i.test(ds.kind) || /transaction/i.test(ds.kind)) schemaType = 'transaction_graph'; else if (/sequence/i.test(ds.kind) || /tabformer/i.test(ds.name)) schemaType = 'sequence'; setInputSchema({ type: schemaType }); }} style={{ width:'100%', padding:'10px 12px', borderRadius:8, border:`1px solid ${T.borderHi}`, background:T.raised, color:T.txt1, fontSize:12, outline:'none', cursor:'pointer' }}>
                                    {sampleDatasets.map((dataset) => (<option key={dataset.name} value={dataset.name}>{dataset.name} - {dataset.kind}</option>))}
                                </select>
                                <a href={selectedSampleDataset.url} target="_blank" rel="noreferrer" style={{ fontSize:12, fontWeight:700, color:'#fff', background:T.accent, border:`1px solid ${T.accent}`, padding:'10px 12px', borderRadius:8, textDecoration:'none', whiteSpace:'nowrap' }}>Open source</a>
                            </div>
                            <div style={{ marginTop:8, fontSize:11, color:T.txt2, lineHeight:1.5 }}>{selectedSampleDataset.summary}</div>
                        </div>
                    </div>
                </Card>

                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:16 }}>
                    <MetricCard label="Total Accounts Scanned" value={totalScanned.toLocaleString()} color={T.txt1} />
                    <MetricCard label="Critical Threats" value={critCount} color={T.crit} />
                    <MetricCard label="High Risk Anomalies" value={highCount} color={T.high} />
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12, marginBottom:14 }}>
                    <MetricCard label="Input Schema" value={inputSchema?.type === 'transaction_graph' ? 'GRAPH' : (inputSchema?.type || 'wide_table')} />
                    <MetricCard label="Alert Threshold" value={modelConfig?.alert_threshold?.toFixed ? modelConfig.alert_threshold.toFixed(2) : (modelConfig?.alert_threshold ?? '0.85')} />
                    <MetricCard label="Critical Threshold" value={modelConfig?.critical_threshold?.toFixed ? modelConfig.critical_threshold.toFixed(2) : (modelConfig?.critical_threshold ?? '0.95')} />
                    <MetricCard label="ROC AUC" value={formatMetricDisplay(modelMetrics?.roc_auc, modelMetrics?.sample_count)} note={modelMetrics?.sample_count && modelMetrics.sample_count < 20 ? 'Insufficient samples to reliably show this metric' : null} />
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
                    <PadCard><PanelHeader kicker="Threshold sweep" title="Alert volume by threshold" description="This chart answers a single question: how many alerts remain as the cutoff rises?" /><div style={{ height:240 }}>{thresholdCurve.length > 0 ? (<ResponsiveContainer width="100%" height="100%"><LineChart data={thresholdCurve} margin={{ top:8, right:16, left:0, bottom:8 }}><CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} /><XAxis dataKey="threshold" label={{ value:'Threshold', position:'insideBottom', offset:-2, fill:T.txt3, fontSize:11 }} tickFormatter={fmtThreshold} tick={{ fill:T.txt3, fontSize:10, fontFamily:'monospace' }} axisLine={false} tickLine={false} angle={-45} textAnchor="end" interval="preserveStartEnd" height={48} /><YAxis label={{ value:'Alerts', angle:-90, position:'insideLeft', fill:T.txt3, fontSize:11 }} tick={{ fill:T.txt3, fontSize:10, fontFamily:'monospace' }} axisLine={false} tickLine={false} /><RechartsTooltip contentStyle={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:6, fontSize:12, color:T.txt1 }} /><Legend wrapperStyle={{ fontSize:12, paddingTop:8, color:T.txt2 }} /><Line type="monotone" dataKey="alert_count" stroke={T.accent} strokeWidth={2} dot={false} name="Alert Count" /></LineChart></ResponsiveContainer>) : (<div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:12, fontFamily:'monospace' }}>No threshold curve</div>)}</div></PadCard>
                    <PadCard><PanelHeader kicker="Feature importance" title="Top Feature Importance" description={null} /><div style={{ height:280 }}>{featureImportance.length > 0 ? (<ResponsiveContainer width="100%" height="100%"><BarChart data={featureImportance.slice(0, 12)} layout="vertical" margin={{ top:0, right:16, left:8, bottom:8 }}><XAxis type="number" hide /><YAxis dataKey="name" type="category" width={110} axisLine={false} tickLine={false} tick={{ fill:T.txt3, fontSize:10, fontFamily:'monospace' }} /><RechartsTooltip cursor={{ fill:'rgba(255,255,255,0.02)' }} content={<BarTooltip />} /><Bar dataKey="importance" fill={T.accent} radius={[0,3,3,0]} /></BarChart></ResponsiveContainer>) : (<div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:12, fontFamily:'monospace' }}>No importance data</div>)}</div></PadCard>
                </div>

                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:10, flexWrap:'wrap', margin:'18px 0 12px 0' }}>
                    <div style={{ fontSize:12, fontWeight:700, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.06em' }}>Audit Logs</div>
                    <button onClick={handleSystemWipe} style={{ display:'flex', alignItems:'center', gap:7, padding:'6px 14px', fontSize:12, fontWeight:600, borderRadius:6, cursor:'pointer', background:T.critBg, border:`1px solid ${T.critBdr}`, color:T.crit }}>Wipe Database</button>
                </div>

                <Card>
                    <table style={{ width:'100%', borderCollapse:'collapse' }}>
                        <thead><tr><TH>Timestamp</TH><TH>Actor</TH><TH>Event</TH><TH>Message</TH></tr></thead>
                        <tbody>{currentLogs.length > 0 ? currentLogs.map((log, i) => (<tr key={i} style={{ borderBottom:`1px solid ${T.border}` }} onMouseEnter={e => e.currentTarget.style.background = T.raised} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}><td style={{ padding:'10px 16px', fontFamily:'monospace', fontSize:12, color:T.txt3, whiteSpace:'nowrap' }}>{new Date(log.timestamp).toLocaleString()}</td><td style={{ padding:'10px 16px' }}><ActorBadge actor={log.actor} /></td><td style={{ padding:'10px 16px' }}><span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color: log.actionType === 'REJECTION' ? T.crit : log.actionType === 'RESOLUTION' ? T.ok : T.txt3 }}>{log.actionType}</span></td><TD>{log.message}</TD></tr>)) : (<tr><td colSpan="4" style={{ padding:'32px 16px', textAlign:'center', color:T.txt3, fontSize:12, fontFamily:'monospace', letterSpacing:'0.08em' }}>NO LOGS FOR THIS FILTER</td></tr>)}</tbody>
                    </table>
                    <Pagination current={currentPage} total={totalLogPages} jumpPage={jumpPage} onJumpChange={e => setJumpPage(e.target.value)} onJumpKey={e => handleJumpKey(e, totalLogPages)} onPrev={() => setCurrentPage(p => Math.max(1,p-1))} onNext={() => setCurrentPage(p => Math.min(totalLogPages,p+1))} />
                </Card>
            </div>
        );

        return (
            <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', background:T.bg, fontFamily:"'Inter', 'Segoe UI', system-ui, sans-serif", fontSize:14, color:T.txt1 }}>
                <style>{`* { box-sizing: border-box; } ::-webkit-scrollbar { width: 6px; height: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 3px; } ::-webkit-scrollbar-thumb:hover { background: ${T.borderHi}; } input::placeholder { color: ${T.txt3}; } select option { background: ${T.raised}; color: ${T.txt1}; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <Toaster />
                <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileUpload} style={{ display:'none' }} />
                <RoleNavigationBar />
                {isUploading && (
                    <div style={{ padding:'16px 20px 0 20px' }}>
                        <Card style={{ padding:'14px 16px', border:`1px solid ${T.borderHi}`, background:`linear-gradient(135deg, ${T.raised} 0%, #17191f 100%)` }}>
                            <div style={{ display:'flex', justifyContent:'space-between', gap:14, flexWrap:'wrap', alignItems:'flex-start' }}>
                                <div style={{ minWidth: 240 }}>
                                    <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:6 }}>Live Upload</div>
                                    <div style={{ fontSize:15, color:T.txt1, fontWeight:700, marginBottom:4, fontFamily:'monospace' }}>{uploadFileName || 'Current dataset'}</div>
                                    <div style={{ fontSize:12, color:T.txt2, lineHeight:1.5 }}>{statusMeta.detail}</div>
                                </div>
                                <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                                    <div style={{ padding:'8px 12px', borderRadius:8, background:T.bg, border:`1px solid ${T.borderHi}` }}>
                                        <div style={{ fontSize:9, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em' }}>Status</div>
                                        <div style={{ fontSize:12, color:statusTone, fontWeight:700, marginTop:2 }}>{statusText}</div>
                                    </div>
                                    <div style={{ padding:'8px 12px', borderRadius:8, background:T.bg, border:`1px solid ${T.borderHi}` }}>
                                        <div style={{ fontSize:9, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em' }}>Elapsed</div>
                                        <div style={{ fontSize:12, color:T.txt1, fontWeight:700, marginTop:2 }}>{formatDuration(uploadElapsedSeconds)}</div>
                                    </div>
                                </div>
                            </div>
                            <div style={{ marginTop:14, display:'grid', gridTemplateColumns:'repeat(5, minmax(0, 1fr))', gap:8 }}>
                                {UPLOAD_PROGRESS_STEPS.map((step, idx) => {
                                    const completed = idx < statusMeta.phase;
                                    const active = idx === statusMeta.phase;
                                    const terminal = idx === 4 && statusMeta.kind !== 'active' && statusMeta.kind !== 'idle';
                                    const stepBg = terminal && statusMeta.kind === 'error' ? T.critBg : completed || active || terminal ? T.accentBg : T.bg;
                                    const stepBorder = terminal && statusMeta.kind === 'error' ? T.critBdr : completed || active || terminal ? T.borderHi : T.border;
                                    const stepColor = terminal && statusMeta.kind === 'error' ? T.crit : completed || active || terminal ? T.txt1 : T.txt3;

                                    return (
                                        <div key={step.label} style={{ padding:'8px 10px', borderRadius:8, background:stepBg, border:`1px solid ${stepBorder}` }}>
                                            <div style={{ fontSize:9, color:stepColor, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:2 }}>
                                                {String(idx + 1).padStart(2, '0')}
                                            </div>
                                            <div style={{ fontSize:12, color:stepColor, fontWeight:700 }}>{step.label}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    </div>
                )}
                <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
                    {currentRole === 'Analyst' ? <AnalystWorkspace /> : <AdminWorkspace />}
                </div>
            </div>
        );
    };

export default Dashboard;

