import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Badge } from './ui/badge';
import { Button, buttonVariants } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { toast } from 'sonner';
import { Play, Database, RefreshCw, AlertCircle, CheckCircle2, Clock, ExternalLink, Activity, Search, ChevronLeft, ChevronRight, FileText, Download, Settings, ShieldCheck, Server, Terminal, ListFilter, Sparkles, Moon, Sun, BookOpen, Eye, X, Cloud, AlertTriangle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Label } from './ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { useTheme } from 'next-themes';
// Dashboard.css import removed as styles are now in index.css

interface SyncRun {
  id: string;
  timestamp: string;
  status: string;
  totalFilesGenerated: number;
  totalItemsParsed: number;
  errorSummary: string | null;
  triggerType: string;
}

interface SourceMetric {
  id: string;
  sourceName: string;
  sourceUrl: string;
  lastSyncTimestamp: string;
  itemsParsedLastSync: number;
  healthStatus: string;
  lastErrorMessage: string | null;
}

interface AppLog {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  syncRunId: string | null;
  metadata: string | null;
}

interface OutputFile {
  name: string;
  size: number;
  lastModified: string;
}

export default function Dashboard() {
  const { theme, setTheme } = useTheme();
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [syncRunsPage, setSyncRunsPage] = useState(1);
  const [syncRunsTotal, setSyncRunsTotal] = useState(0);
  const [metrics, setMetrics] = useState<SourceMetric[]>([]);
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  // Debug Console State
  const [debugLogs, setDebugLogs] = useState<AppLog[]>([]);
  const [debugPage, setDebugPage] = useState(1);
  const [debugTotal, setDebugTotal] = useState(0);
  const [debugLevel, setDebugLevel] = useState('ALL');
  const [debugSearch, setDebugSearch] = useState('');
  const [debugLoading, setDebugLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AppLog | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const debugScrollRef = useRef<HTMLDivElement>(null);

  // Network Console State
  const [networkLogs, setNetworkLogs] = useState<AppLog[]>([]);
  const [networkPage, setNetworkPage] = useState(1);
  const [networkTotal, setNetworkTotal] = useState(0);
  const [networkSearch, setNetworkSearch] = useState('');
  const [networkLoading, setNetworkLoading] = useState(false);
  const [selectedNetworkLog, setSelectedNetworkLog] = useState<AppLog | null>(null);

  // Run Details State
  const [selectedRun, setSelectedRun] = useState<SyncRun | null>(null);
  const [runLogs, setRunLogs] = useState<AppLog[]>([]);
  const [runLogsLoading, setRunLogsLoading] = useState(false);

  // Gemini Brief State
  const [geminiBrief, setGeminiBrief] = useState<string | null>(null);
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);

  // Settings State
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [purging, setPurging] = useState(false);
  const [systemStatus, setSystemStatus] = useState<any>(null);

  // GCS Export State
  const [isGCSDialogOpen, setIsGCSDialogOpen] = useState(false);
  const [gcsProjectId, setGcsProjectId] = useState('');
  const [gcsBucketName, setGcsBucketName] = useState('');
  const [gcsAuthCode, setGcsAuthCode] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const handleGCSExport = async () => {
    if (!gcsProjectId || !gcsBucketName || !gcsAuthCode) {
      toast.error('Project ID, Bucket Name, and Auth Code are required');
      return;
    }

    setIsExporting(true);
    try {
      const result = await fetchJson('/api/v1/files-export-gcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: gcsProjectId,
          bucketName: gcsBucketName,
          authCode: gcsAuthCode
        })
      });
      if (result.success) {
        toast.success(result.message);
        setIsGCSDialogOpen(false);
        // Reset form
        setGcsAuthCode('');
      } else {
        toast.error(result.error || 'Export failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export to GCS');
      console.error(error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadAll = () => {
    window.open('/api/v1/files-download-all', '_blank');
  };

  const exportSyncRunsCsv = () => {
    if (runs.length === 0) return;
    const headers = ['ID', 'Timestamp', 'Status', 'Trigger Type', 'Items Parsed', 'Files Generated', 'Error Summary'];
    const rows = runs.map(r => [
      r.id,
      new Date(r.timestamp).toISOString(),
      r.status,
      r.triggerType,
      r.totalItemsParsed,
      r.totalFilesGenerated,
      r.errorSummary ? `"${r.errorSummary.replace(/"/g, '""')}"` : ''
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `sync_runs_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const fetchJson = async (url: string, options?: RequestInit, retries = 3) => {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, options);
        
        // Handle rate limiting (429) with exponential backoff
        if (res.status === 429) {
          const delay = Math.pow(2, i) * 2000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (!res.ok) {
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errData = await res.json().catch(() => null);
            throw new Error(errData?.error || `HTTP error! status: ${res.status}`);
          }
          throw new Error(`HTTP error! status: ${res.status}`);
        }

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          const text = await res.text();
          console.error(`Expected JSON response but received ${contentType || 'unknown content'}:`, text.substring(0, 100));
          throw new Error(`Expected JSON response but received ${contentType || 'unknown content'}. This often happens if the API route is missing or returning an HTML error page.`);
        }

        return await res.json();
      } catch (error) {
        lastError = error;
        // If it's a 429, we already handled it with 'continue'
        // For other errors, we retry unless it's the last attempt
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw lastError;
  };

  const [analytics, setAnalytics] = useState<any>(null);

  const fetchSystemStatus = async () => {
    try {
      const res = await fetchJson('/api/v1/system/status');
      if (res.success) setSystemStatus(res.data);
    } catch (error) {
      console.error('Failed to fetch system status:', error);
    }
  };

  const fetchSettings = async () => {
    try {
      setSettingsLoading(true);
      const res = await fetchJson('/api/v1/system/settings');
      if (res.success) setSettings(res.data);
    } catch (error) {
      console.error('Failed to fetch settings:', error);
    } finally {
      setSettingsLoading(false);
    }
  };

  const updateSetting = async (key: string, value: string) => {
    try {
      const res = await fetchJson('/api/v1/system/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ key, value })
      });
      if (res.success) {
        toast.success(`Setting ${key} updated`);
        fetchSettings();
      } else {
        toast.error(res.error || 'Failed to update setting');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update setting');
    }
  };

  const purgeSystem = async () => {
    if (!confirm('Are you absolutely sure? This will delete ALL data and files.')) return;
    try {
      setPurging(true);
      const res = await fetchJson('/api/v1/system/purge', {
        method: 'POST'
      });
      if (res.success) {
        toast.success('System purged successfully');
        fetchData();
      } else {
        toast.error(res.error || 'Failed to purge system');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to purge system');
    } finally {
      setPurging(false);
    }
  };

  const fetchData = async () => {
    try {
      const [runsRes, metricsRes, filesRes, analyticsRes] = await Promise.all([
        fetchJson(`/api/v1/sync-runs?page=${syncRunsPage}&limit=10`),
        fetchJson('/api/v1/source-metrics'),
        fetchJson('/api/v1/files'),
        fetchJson('/api/v1/analytics')
      ]);

      if (runsRes.success) {
        setRuns(runsRes.data);
        setSyncRunsTotal(runsRes.total);
        
        // Check if any run is currently running to update global syncing state
        const isAnyRunning = runsRes.data.some((run: any) => run.status === 'RUNNING');
        if (isAnyRunning) {
          setSyncing(true);
        } else if (!syncing) {
          // Only set to false if we weren't already in a manual trigger state
          // This prevents the button from flickering if the poll happens right after trigger
          setSyncing(false);
        }
      }
      if (metricsRes.success) setMetrics(metricsRes.data);
      if (filesRes?.success) setFiles(filesRes.data);
      if (analyticsRes?.success) setAnalytics(analyticsRes.data);
    } catch (error) {
      console.error("Fetch error:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(
        <div className="flex flex-col gap-1">
          <span className="font-semibold">Failed to fetch dashboard data</span>
          <span className="text-sm opacity-90">{errorMessage}</span>
        </div>
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000); // Poll every 2s for live refresh
    return () => clearInterval(interval);
  }, [syncRunsPage]);

  const fetchDebugLogs = async () => {
    setDebugLoading(true);
    try {
      const params = new URLSearchParams({
        page: debugPage.toString(),
        limit: '50',
        excludeLevel: 'NETWORK'
      });
      if (debugLevel !== 'ALL') params.append('level', debugLevel);
      if (debugSearch) params.append('search', debugSearch);
      
      const data = await fetchJson(`/api/v1/logs?${params.toString()}`);
      if (data.success) {
        setDebugLogs(data.data);
        setDebugTotal(data.total);
      }
    } catch (error) {
      console.error("Failed to fetch debug logs:", error);
    } finally {
      setDebugLoading(false);
    }
  };

  const fetchNetworkLogs = async () => {
    setNetworkLoading(true);
    try {
      const params = new URLSearchParams({
        page: networkPage.toString(),
        limit: '50',
        level: 'NETWORK'
      });
      if (networkSearch) params.append('search', networkSearch);
      
      const data = await fetchJson(`/api/v1/logs?${params.toString()}`);
      if (data.success) {
        setNetworkLogs(data.data);
        setNetworkTotal(data.total);
      }
    } catch (error) {
      console.error("Failed to fetch network logs:", error);
    } finally {
      setNetworkLoading(false);
    }
  };

  const fetchRunLogs = async (runId: string) => {
    setRunLogsLoading(true);
    try {
      const data = await fetchJson(`/api/v1/logs?syncRunId=${runId}&limit=1000`);
      if (data.success) {
        setRunLogs(data.data);
      }
    } catch (error) {
      console.error("Failed to fetch run logs:", error);
      toast.error("Failed to fetch logs for this run");
    } finally {
      setRunLogsLoading(false);
    }
  };

  const fetchGeminiBrief = async () => {
    setGeminiLoading(true);
    setGeminiError(null);
    try {
      // Step 1: Fetch the content from the backend
      const data = await fetchJson('/api/v1/gemini/content');
      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch content for brief');
      }

      if (!data.content) {
        setGeminiBrief("No data available yet. Please run a sync first.");
        return;
      }

      // Step 2: Generate the brief using Gemini on the frontend
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('Gemini API key is not configured in the environment.');
      }

      const ai = new GoogleGenAI({ apiKey });
      
      // Implement retry for Gemini generation to handle 429 errors
      let response;
      let genRetries = 3;
      for (let i = 0; i < genRetries; i++) {
        try {
          response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [
              {
                role: "user",
                parts: [{
                  text: `You are an expert data analyst and technical writer. Below is a collection of recent internal data feeds from various sources (AI research, cloud innovation, security bulletins, releases, etc.). 
                  
                  Your task is to generate a "Weekly Intelligence Brief" that provides a high-impact, actionable summary of the most critical developments from the last week.
                  
                  Requirements:
                  1. Format the output using high-quality, sophisticated Markdown.
                  2. Use a professional, authoritative, and concise tone.
                  3. Include the following mandatory sections: 
                     - **Executive Intelligence Summary**: A high-level overview of the most significant trends.
                     - **Critical Security Bulletins**: A detailed table summarizing vulnerabilities, severity levels, and required actions.
                     - **Release Notes & Product Updates**: A categorized list of major feature launches and technical improvements.
                     - **Product Deprecations & Lifecycle Alerts**: Clearly highlight upcoming deprecations or end-of-life notices.
                     - **Strategic Recommendations**: Actionable steps for the engineering and security teams.
                  4. Use tables for security data, bolding for emphasis, and nested lists for technical details.
                  5. Ensure the formatting is visually impressive and easy to scan.
                  6. Focus strictly on the most recent and critical information provided in the feeds.
                  7. Use Markdown features like blockquotes for key insights, horizontal rules for section separation, and code blocks for technical snippets or commands.
                  8. Add a "Data Sources & Methodology" section at the end.
                  
                  Data Feeds:
                  ${data.content}`
                }]
              }
            ]
          });
          break; // Success, exit retry loop
        } catch (err: any) {
          const isRateLimit = err.message?.includes('429') || err.status === 429;
          if (isRateLimit && i < genRetries - 1) {
            const delay = Math.pow(2, i) * 3000;
            console.warn(`Gemini rate limit hit (429). Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }

      if (response && response.text) {
        setGeminiBrief(response.text);
      } else {
        throw new Error('Gemini returned an empty response.');
      }
    } catch (error) {
      console.error("Failed to generate Gemini brief:", error);
      setGeminiError(error instanceof Error ? error.message : 'Failed to generate brief');
    } finally {
      setGeminiLoading(false);
    }
  };

  const openRunDetails = (run: SyncRun) => {
    setSelectedRun(run);
    setRunLogs([]);
    fetchRunLogs(run.id);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchDebugLogs();
    }, 300);
    return () => clearTimeout(timer);
  }, [debugPage, debugLevel, debugSearch]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchNetworkLogs();
    }, 300);
    return () => clearTimeout(timer);
  }, [networkPage, networkSearch]);

  // Real-time polling for logs when on the debug tab
  useEffect(() => {
    if (activeTab === 'debug') {
      const interval = setInterval(() => {
        fetchDebugLogs();
        fetchNetworkLogs();
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [activeTab, debugPage, debugLevel, debugSearch, networkPage, networkSearch]);

  useEffect(() => {
    if (autoScroll && debugScrollRef.current) {
      const scrollElement = debugScrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [debugLogs, autoScroll]);

  useEffect(() => {
    if (activeTab === 'settings') {
      fetchSettings();
      fetchSystemStatus();
    }
  }, [activeTab]);

  const chartData = useMemo(() => {
    return [...runs].reverse().map(run => ({
      time: new Date(run.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      items: run.totalItemsParsed,
      status: run.status
    }));
  }, [runs]);

  const triggerSync = async (sourceId?: string, force: boolean = false) => {
    setSyncing(true);
    const endpoint = sourceId ? '/api/v1/sync/targeted' : '/api/v1/sync/monthly';
    const body = sourceId ? JSON.stringify({ sourceId, force }) : JSON.stringify({ triggerType: 'MANUAL', force });
    
    try {
      const res = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body
      });
      
      if (res.success) {
        toast.success(res.message);
        fetchData();
      } else {
        console.error('Sync error details:', res);
        toast.error(
          <div className="flex flex-col gap-1">
            <span className="font-semibold">{res.details || 'Sync failed'}</span>
            <span className="text-sm opacity-90">{res.error}</span>
          </div>,
          { duration: 10000 }
        );
      }
    } catch (error) {
      console.error('Network error triggering sync:', error);
      toast.error(error instanceof Error ? error.message : 'Network error: Failed to trigger sync');
    } finally {
      setSyncing(false);
    }
  };

  const testConnection = async (sourceId: string) => {
    const toastId = toast.loading('Testing connection...');
    try {
      const res = await fetchJson('/api/v1/sync/test', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sourceId })
      });
      if (res.success) {
        toast.success(res.message, { id: toastId });
      } else {
        toast.error(res.error || 'Connection test failed', { id: toastId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Network error during connection test', { id: toastId });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'SUCCESS':
      case 'HEALTHY':
        return <Badge variant="outline" className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"><CheckCircle2 className="w-3 h-3 mr-1" /> {status}</Badge>;
      case 'RUNNING':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"><RefreshCw className="w-3 h-3 mr-1 animate-spin" /> {status}</Badge>;
      case 'PARTIAL_SUCCESS':
      case 'DEGRADED':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20"><AlertCircle className="w-3 h-3 mr-1" /> {status}</Badge>;
      case 'FAILED':
      case 'FAILING':
      case 'ERROR':
        return <Badge variant="outline" className="bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"><AlertCircle className="w-3 h-3 mr-1" /> {status}</Badge>;
      case 'INFO':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"><Activity className="w-3 h-3 mr-1" /> {status}</Badge>;
      default:
        return <Badge variant="outline" className="border-border text-foreground rounded-full">{status}</Badge>;
    }
  };

  return (
    <div className="dashboard-container">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col min-h-screen">
        <header className="dashboard-header">
          <div className="max-w-[1920px] mx-auto w-full flex items-center justify-between">
            <div className="flex items-center gap-4">
              <motion.div 
                whileHover={{ scale: 1.05 }}
                className="dashboard-logo-box"
              >
                <Database className="h-5 w-5" />
              </motion.div>
              <div className="flex items-center gap-2">
                <span className="dashboard-title">GCP Datanator</span>
                <span className="dashboard-version">v0.9.0</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="h-8 w-8 text-white hover:bg-white/10"
              >
                <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              </Button>

              <Button 
                onClick={() => triggerSync(undefined, true)} 
                disabled={syncing}
                className="h-8 px-3 text-xs flex items-center gap-2"
              >
                {syncing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {syncing ? 'Syncing...' : 'Sync Now'}
              </Button>
            </div>
          </div>
        </header>

        {/* Repository Header Style */}
        <div className="bg-[#f6f8fa] dark:bg-[#010409] pt-6 pb-0">
          <div className="content-container py-0">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
              <div className="flex items-center gap-2 text-xl">
                <Database className="w-5 h-5 text-muted-foreground" />
                <span className="text-primary hover:underline cursor-pointer">google-cloud</span>
                <span className="text-muted-foreground">/</span>
                <span className="font-semibold text-primary hover:underline cursor-pointer">gcp-datanator-core</span>
                <Badge variant="outline" className="ml-2 rounded-full text-[12px] font-medium px-2 py-0 border-border text-muted-foreground">Public</Badge>
              </div>
            </div>

            <TabsList className="nav-tabs-list">
              <TabsTrigger value="overview">
                <Activity className="w-4 h-4 mr-2" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="gemini">
                <Sparkles className="w-4 h-4 mr-2" />
                Intelligence
              </TabsTrigger>
              <TabsTrigger value="sources">
                <Database className="w-4 h-4 mr-2" />
                Sources
              </TabsTrigger>
              <TabsTrigger value="files">
                <FileText className="w-4 h-4 mr-2" />
                Files
              </TabsTrigger>
              <TabsTrigger value="debug">
                <Terminal className="w-4 h-4 mr-2" />
                Logs
              </TabsTrigger>
              <TabsTrigger value="settings">
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        <main className="content-container">
        <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
                <TabsContent value="overview" className="mt-0">
                  <div className="grid-github">
                    {/* Main Content: File List Style */}
                    <div className="content-github space-y-6">
                      <div className="github-card">
                        <div className="github-card-header">
                          <div className="flex items-center gap-2">
                            <Database className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-semibold">Recent Sync Cycles</span>
                          </div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {runs.length} runs recorded
                          </div>
                        </div>
                        <div className="overflow-hidden">
                          <table className="github-table">
                            <thead>
                              <tr>
                                <th>Timestamp</th>
                                <th>Status</th>
                                <th>Trigger</th>
                                <th className="text-right">Items</th>
                                <th className="text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {runs.slice(0, 8).map((run) => (
                                <tr key={run.id} onClick={() => openRunDetails(run)} className="cursor-pointer group">
                                  <td className="font-mono text-[12px] text-primary group-hover:underline">
                                    {new Date(run.timestamp).toLocaleString()}
                                  </td>
                                  <td>{getStatusBadge(run.status)}</td>
                                  <td>
                                    <span className="text-[12px] text-muted-foreground">{run.triggerType}</span>
                                  </td>
                                  <td className="text-right font-mono text-[12px]">{run.totalItemsParsed}</td>
                                  <td className="text-right">
                                    <ChevronRight className="w-4 h-4 ml-auto text-muted-foreground group-hover:text-primary transition-colors" />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="px-4 py-3 bg-muted border-t border-border text-center">
                          <Button variant="ghost" size="sm" onClick={() => setActiveTab('debug')} className="text-xs text-primary font-semibold hover:bg-primary/10">
                            View all system logs
                          </Button>
                        </div>
                      </div>

                      {/* README Style Section */}
                      <div className="github-card">
                        <div className="github-card-header">
                          <div className="flex items-center gap-2">
                            <BookOpen className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-semibold uppercase tracking-wider">README.md</span>
                          </div>
                        </div>
                        <div className="p-8 markdown-body">
                          <div className="flex items-center gap-3 mb-6">
                            <h1 className="!mb-0 !pb-0 !border-0 !mt-0">⚡ GCP Datanator Dashboard</h1>
                            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 hover:bg-primary/20">v0.9.0</Badge>
                          </div>
                          
                          <p className="text-lg text-muted-foreground leading-relaxed">
                            Welcome to the GCP Datanator control plane. This system orchestrates the ingestion, transformation, and synthesis of technical data feeds from across the Google Cloud ecosystem into a unified knowledge base.
                          </p>
                          
                          <div className="flex flex-wrap gap-2 my-6">
                            <Badge variant="secondary" className="rounded-md font-mono text-xs"><Database className="w-3 h-3 mr-1" /> SQLite WAL</Badge>
                            <Badge variant="secondary" className="rounded-md font-mono text-xs"><Activity className="w-3 h-3 mr-1" /> {metrics.length} Sources</Badge>
                            <Badge variant="secondary" className="rounded-md font-mono text-xs"><Sparkles className="w-3 h-3 mr-1" /> Gemini AI</Badge>
                            <Badge variant="secondary" className="rounded-md font-mono text-xs"><Terminal className="w-3 h-3 mr-1" /> Express.js</Badge>
                          </div>

                          <h2>System Overview</h2>
                          <p>GCP Datanator is built for high-reliability and data sovereignty, ensuring your engineering teams always have access to the latest technical updates without relying on third-party SaaS aggregators.</p>
                          
                          <ul className="space-y-2 mt-4">
                            <li className="flex items-start gap-2">
                              <div className="mt-1 bg-green-500/20 p-1 rounded-full"><CheckCircle2 className="w-3 h-3 text-green-500" /></div>
                              <span><strong>ETL Pipeline:</strong> Automated ingestion from {metrics.length} distinct data sources with atomic transactions and sequential processing.</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <div className="mt-1 bg-blue-500/20 p-1 rounded-full"><Activity className="w-3 h-3 text-blue-500" /></div>
                              <span><strong>Self-Healing:</strong> Automatically detects and recovers from stuck sync jobs or unexpected container restarts.</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <div className="mt-1 bg-purple-500/20 p-1 rounded-full"><Sparkles className="w-3 h-3 text-purple-500" /></div>
                              <span><strong>Intelligence Engine:</strong> Gemini-powered synthesis of raw feeds into actionable briefs.</span>
                            </li>
                            <li className="flex items-start gap-2">
                              <div className="mt-1 bg-orange-500/20 p-1 rounded-full"><Database className="w-3 h-3 text-orange-500" /></div>
                              <span><strong>Data Sovereignty:</strong> 100% local storage and processing. No third-party cloud dependencies.</span>
                            </li>
                          </ul>

                          <div className={`border-l-4 p-4 my-8 rounded-r-md flex items-start gap-3 ${systemStatus?.status === 'HEALTHY' ? 'bg-green-500/10 border-green-500' : 'bg-yellow-500/10 border-yellow-500'}`}>
                            {systemStatus?.status === 'HEALTHY' ? (
                              <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 mt-0.5" />
                            ) : (
                              <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5" />
                            )}
                            <div>
                              <p className="text-sm font-semibold m-0 text-foreground">System Status</p>
                              <p className="text-sm m-0 mt-1 text-muted-foreground">
                                The ETL pipeline is currently operating normally. All subsystems are <span className={systemStatus?.status === 'HEALTHY' ? 'text-green-600 dark:text-green-400 font-bold' : 'text-yellow-600 dark:text-yellow-400 font-bold'}>
                                  {systemStatus?.status || 'OPERATIONAL'}
                                </span>.
                              </p>
                            </div>
                          </div>

                          <h2>Quick Start</h2>
                          <p>To initialize a manual synchronization cycle, use the <strong>Sync</strong> button in the top navigation bar. For detailed logs, visit the <strong>Logs</strong> tab.</p>
                          
                          <pre className="mt-4">
                            <code>
<span className="text-muted-foreground"># View real-time logs</span><br/>
tail -f data/gcp-datanator.db<br/>
<br/>
<span className="text-muted-foreground"># Trigger manual sync via API</span><br/>
curl -X POST http://localhost:3000/api/sync/manual
                            </code>
                          </pre>
                        </div>
                      </div>
                    </div>

                    {/* Sidebar Stats */}
                    <div className="sidebar-github space-y-6">
                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold">About</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          Self-hosted technical intelligence aggregator for SRE and Engineering teams. Built for high-density data synthesis.
                        </p>
                        <div className="flex flex-col gap-3 pt-2">
                          <div className="flex items-center gap-2 text-sm">
                            <Activity className="w-4 h-4 text-muted-foreground" />
                            <span>{analytics?.successRate || 0}% success rate</span>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <Database className="w-4 h-4 text-muted-foreground" />
                            <span>{analytics?.totalItems ? (analytics.totalItems / 1000).toFixed(1) + 'k' : '0'} items parsed</span>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <Clock className="w-4 h-4 text-muted-foreground" />
                            <span>Last sync: {runs[0] ? new Date(runs[0].timestamp).toLocaleTimeString() : 'Never'}</span>
                          </div>
                        </div>
                      </div>

                      <Separator className="bg-border" />

                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold">Source Health</h3>
                        <div className="space-y-3">
                          {metrics.slice(0, 5).map(m => (
                            <div key={m.id} className="flex items-center justify-between group cursor-pointer" onClick={() => setActiveTab('sources')}>
                              <div className="flex items-center gap-2 overflow-hidden">
                                <div className={`w-2 h-2 rounded-full shrink-0 ${m.healthStatus === 'HEALTHY' ? 'bg-success shadow-[0_0_8px_rgba(63,185,80,0.4)]' : 'bg-error shadow-[0_0_8px_rgba(248,81,73,0.4)]'}`} />
                                <span className="text-xs font-medium truncate group-hover:text-primary transition-colors">{m.sourceName}</span>
                              </div>
                              <span className="text-[10px] font-mono text-muted-foreground">{m.itemsParsedLastSync}</span>
                            </div>
                          ))}
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => setActiveTab('sources')} className="w-full text-xs text-primary font-semibold justify-start p-0 h-auto hover:bg-transparent hover:underline">
                          View all sources
                        </Button>
                      </div>

                      <Separator className="bg-border" />

                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold">Deployment</h3>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <div className="w-2 h-2 rounded-full bg-success" />
                          <span>Cloud Run (Production)</span>
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground opacity-60">
                          Region: europe-west2
                        </div>
                      </div>

                      <Separator className="bg-border" />

                      <div className="space-y-4">
                        <h3 className="text-sm font-semibold">Languages</h3>
                        <div className="w-full h-2 bg-muted rounded-full overflow-hidden flex">
                          <div className="h-full bg-blue-500" style={{ width: '70.2%' }} />
                          <div className="h-full bg-yellow-500" style={{ width: '19.8%' }} />
                          <div className="h-full bg-purple-500" style={{ width: '10.0%' }} />
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                          <div className="flex items-center gap-1.5 text-xs">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <span className="font-semibold">TypeScript</span>
                            <span className="text-muted-foreground">70.2%</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs">
                            <div className="w-2 h-2 rounded-full bg-yellow-500" />
                            <span className="font-semibold">JavaScript</span>
                            <span className="text-muted-foreground">19.8%</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs">
                            <div className="w-2 h-2 rounded-full bg-purple-500" />
                            <span className="font-semibold">CSS</span>
                            <span className="text-muted-foreground">10.0%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="gemini" className="mt-0">
                  <div className="github-card">
                    <div className="github-card-header">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-primary" />
                        <span className="text-sm font-semibold">Intelligence Brief</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={fetchGeminiBrief}
                          disabled={geminiLoading}
                          className="h-7 text-xs font-semibold hover:bg-primary/10"
                        >
                          {geminiLoading ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                          Regenerate
                        </Button>
                      </div>
                    </div>
                    <div className="p-0 bg-card">
                      {geminiLoading ? (
                        <div className="flex flex-col items-center justify-center py-32 space-y-4">
                          <RefreshCw className="w-10 h-10 text-primary animate-spin" />
                          <p className="text-sm text-muted-foreground animate-pulse font-mono">Synthesizing technical feeds...</p>
                        </div>
                      ) : geminiError ? (
                        <div className="flex flex-col items-center justify-center py-32 text-center px-4">
                          <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4 opacity-50" />
                          <h3 className="text-lg font-semibold mb-2">Synthesis Failed</h3>
                          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">{geminiError}</p>
                          <Button onClick={fetchGeminiBrief} variant="outline" className="h-9 text-xs font-semibold">
                            Retry Synthesis
                          </Button>
                        </div>
                      ) : geminiBrief ? (
                        <div className="p-8 sm:p-12">
                          <div className="markdown-body border border-border rounded-md p-8 sm:p-12 bg-card">
                            <ReactMarkdown>{geminiBrief}</ReactMarkdown>
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-32 px-4">
                          <Sparkles className="w-16 h-16 text-muted-foreground mx-auto mb-6 opacity-20" />
                          <h3 className="text-xl font-semibold mb-2">No Brief Generated</h3>
                          <p className="text-sm text-muted-foreground mb-8 max-w-md mx-auto">
                            Initialize a sync cycle to provide Gemini with fresh data for analysis and synthesis.
                          </p>
                          <Button onClick={fetchGeminiBrief} className="px-8">
                            Generate Now
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="sources" className="mt-0">
                  <div className="github-card">
                    <div className="github-card-header">
                      <div className="flex items-center gap-2">
                        <Database className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">Data Source Matrix</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-[12px] text-muted-foreground mr-2">
                          <span className="font-semibold text-foreground">{metrics.length}</span> sources
                        </div>
                        <Button variant="ghost" size="sm" className="h-7 text-xs font-semibold hover:bg-primary/10" onClick={() => fetchData()}>
                          <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                          Refresh
                        </Button>
                      </div>
                    </div>
                    <div className="overflow-hidden">
                      <table className="github-table">
                        <thead>
                          <tr>
                            <th>Source</th>
                            <th>Status</th>
                            <th>Last Sync</th>
                            <th className="text-right">Volume</th>
                            <th className="text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {metrics.map((m) => (
                            <tr key={m.id} className="group">
                              <td>
                                <div className="flex flex-col">
                                  <span className="font-semibold text-primary group-hover:underline cursor-pointer">{m.sourceName}</span>
                                  <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">{m.sourceUrl}</span>
                                </div>
                              </td>
                              <td>
                                <div className="flex items-center gap-2">
                                  <div className={`w-2 h-2 rounded-full ${m.healthStatus === 'HEALTHY' ? 'bg-success shadow-[0_0_8px_rgba(63,185,80,0.4)]' : 'bg-error shadow-[0_0_8px_rgba(248,81,73,0.4)]'}`} />
                                  <span className="text-[12px]">{m.healthStatus}</span>
                                </div>
                              </td>
                              <td className="text-[12px] text-muted-foreground">
                                {m.lastSyncTimestamp ? new Date(m.lastSyncTimestamp).toLocaleString() : 'NEVER'}
                              </td>
                              <td className="text-right font-mono text-[12px]">{m.itemsParsedLastSync} items</td>
                              <td className="text-right">
                                <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <Button variant="ghost" size="sm" onClick={() => testConnection(m.id)} className="h-7 text-xs text-primary font-semibold hover:bg-primary/10">Test</Button>
                                  <Button variant="ghost" size="sm" onClick={() => triggerSync(m.id, true)} className="h-7 text-xs text-primary font-semibold hover:bg-primary/10">Sync</Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="files" className="mt-0">
                  <div className="github-card">
                    <div className="github-card-header">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-primary hover:underline cursor-pointer font-semibold">gcp-datanator-core</span>
                          <span className="text-muted-foreground">/</span>
                          <span className="font-semibold">output</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-[12px] text-muted-foreground mr-4">
                          <span className="font-semibold text-foreground">{files.length}</span> files
                        </div>
                        <Button variant="outline" size="sm" className="h-7 text-xs font-semibold" onClick={handleDownloadAll} disabled={files.length === 0}>
                          <Download className="w-3 h-3 mr-1" />
                          Download All
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 text-xs font-semibold" onClick={() => setIsGCSDialogOpen(true)} disabled={files.length === 0}>
                          <Cloud className="w-3 h-3 mr-1" />
                          Export to GCS
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs font-semibold" onClick={() => fetchData()}>
                          <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                          Refresh
                        </Button>
                      </div>
                    </div>
                    <div className="overflow-hidden">
                      <div className="divide-y divide-border">
                        {files.map((file) => (
                          <div key={file.name} className="flex items-center justify-between px-4 py-2 hover:bg-muted transition-colors group">
                            <div className="flex items-center gap-3 min-w-0">
                              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                              <div className="flex flex-col min-w-0">
                                <span className="font-semibold text-sm text-primary hover:underline cursor-pointer truncate">{file.name}</span>
                                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                  <span>{(file.size / 1024).toFixed(1)} KB</span>
                                  <span>•</span>
                                  <span>{new Date(file.lastModified).toLocaleString()}</span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="outline" size="sm" className="h-7 text-[11px] font-semibold" onClick={() => window.open(`/api/v1/files/${file.name}`, '_blank')}>
                                <Eye className="w-3 h-3 mr-1" />
                                View
                              </Button>
                              <Button variant="outline" size="sm" className="h-7 text-[11px] font-semibold" onClick={() => window.open(`/api/v1/files/${file.name}?download=1`, '_blank')}>
                                <Download className="w-3 h-3 mr-1" />
                                Download
                              </Button>
                            </div>
                          </div>
                        ))}
                        {files.length === 0 && (
                          <div className="py-20 text-center text-muted-foreground">
                            <div className="flex flex-col items-center gap-2">
                              <FileText className="w-8 h-8 opacity-20" />
                              <p className="text-sm">No output artifacts found.</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="debug" className="mt-0 h-[700px] flex flex-col">
                  <div className="github-card flex-1 flex flex-col overflow-hidden">
                    <div className="github-card-header">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-4 h-4" />
                        <span className="text-sm font-semibold">System Logs</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                          </span>
                          Live
                        </div>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => setAutoScroll(!autoScroll)}
                          className={`h-7 text-xs font-semibold ${autoScroll ? 'text-primary' : ''}`}
                        >
                          Auto-scroll
                        </Button>
                      </div>
                    </div>
                    
                    <div className="flex flex-col sm:flex-row gap-4 p-3 border-b border-border bg-muted/30">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          placeholder="Filter logs..."
                          className="pl-8 h-8 bg-card border-border font-mono text-xs"
                          value={debugSearch}
                          onChange={(e) => { setDebugSearch(e.target.value); setDebugPage(1); }}
                        />
                      </div>
                      <Select value={debugLevel} onValueChange={(val) => { setDebugLevel(val); setDebugPage(1); }}>
                        <SelectTrigger className="w-[140px] h-8 bg-card border-border font-mono text-xs">
                          <SelectValue placeholder="Level" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">ALL LEVELS</SelectItem>
                          <SelectItem value="INFO">INFO</SelectItem>
                          <SelectItem value="WARN">WARN</SelectItem>
                          <SelectItem value="ERROR">ERROR</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex-1 flex overflow-hidden">
                      <div className={`flex-1 flex flex-col overflow-hidden ${selectedLog ? 'w-2/3 border-r border-border' : 'w-full'}`}>
                        <ScrollArea className="flex-1 bg-[#0d1117] text-white" ref={debugScrollRef}>
                          <div className="p-4 font-mono text-[11px] leading-relaxed">
                            {debugLogs.map((log) => (
                              <div 
                                key={log.id} 
                                onClick={() => setSelectedLog(log)}
                                className={`flex gap-3 px-2 py-0.5 cursor-pointer hover:bg-white/5 ${selectedLog?.id === log.id ? 'bg-white/10' : ''}`}
                              >
                                <span className="text-muted-foreground shrink-0">{new Date(log.timestamp).toISOString().split('T')[1].split('.')[0]}</span>
                                <span className={`shrink-0 w-[45px] font-bold ${
                                  log.level === 'ERROR' ? 'text-red-400' : 
                                  log.level === 'WARN' ? 'text-yellow-400' : 
                                  'text-blue-400'
                                }`}>
                                  {log.level}
                                </span>
                                <span className="truncate flex-1">{log.message}</span>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                        <div className="px-4 py-2 border-t border-border bg-card flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                          <div>
                            {debugTotal} entries found
                          </div>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setDebugPage(p => Math.max(1, p - 1))} disabled={debugPage === 1}>
                              Prev
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setDebugPage(p => p + 1)} disabled={debugPage * 50 >= debugTotal}>
                              Next
                            </Button>
                          </div>
                        </div>
                      </div>

                      <AnimatePresence>
                        {selectedLog && (
                          <motion.div 
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: '33.333333%', opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            className="bg-card flex flex-col overflow-hidden border-l border-border"
                          >
                            <div className="p-3 border-b border-border flex justify-between items-center bg-muted/30">
                              <span className="font-semibold text-xs text-foreground uppercase tracking-wider">Log Details</span>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 rounded-full text-muted-foreground hover:text-foreground" onClick={() => setSelectedLog(null)}>
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                            <ScrollArea className="flex-1 p-4">
                              <div className="space-y-4 font-mono text-[11px]">
                                <div>
                                  <div className="text-muted-foreground mb-1">Timestamp</div>
                                  <div className="text-foreground">{new Date(selectedLog.timestamp).toISOString()}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground mb-1">Level</div>
                                  <div>{getStatusBadge(selectedLog.level)}</div>
                                </div>
                                <div>
                                  <div className="text-muted-foreground mb-1">Message</div>
                                  <div className="whitespace-pre-wrap break-all text-foreground bg-muted/50 p-2 rounded border border-border/50">{selectedLog.message}</div>
                                </div>
                                {selectedLog.metadata && (
                                  <div>
                                    <div className="text-muted-foreground mb-1">Metadata</div>
                                    <pre className="bg-muted p-3 rounded-md border border-border text-primary overflow-x-auto text-[10px]">
                                      {(() => {
                                        try {
                                          return JSON.stringify(JSON.parse(selectedLog.metadata), null, 2);
                                        } catch {
                                          return selectedLog.metadata;
                                        }
                                      })()}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            </ScrollArea>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="network" className="mt-0 h-[700px] flex flex-col">
                  <div className="github-card flex-1 flex flex-col overflow-hidden">
                    <div className="github-card-header">
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">Network Telemetry</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                          </span>
                          Live
                        </div>
                        <Button variant="ghost" size="sm" className="h-7 text-xs font-semibold hover:bg-primary/10" onClick={() => fetchData()}>
                          <RefreshCw className={`w-3 h-3 mr-1 ${networkLoading ? 'animate-spin' : ''}`} />
                          Refresh
                        </Button>
                      </div>
                    </div>
                    
                    <div className="flex flex-col sm:flex-row gap-4 p-3 border-b border-border bg-muted/30">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          placeholder="Filter requests..."
                          className="pl-8 h-8 bg-card border-border font-mono text-xs"
                          value={networkSearch}
                          onChange={(e) => { setNetworkSearch(e.target.value); setNetworkPage(1); }}
                        />
                      </div>
                    </div>
                      
                    <div className="flex-1 flex overflow-hidden">
                      <div className={`flex-1 flex flex-col overflow-hidden ${selectedNetworkLog ? 'w-2/3 border-r border-border' : 'w-full'}`}>
                        <ScrollArea className="flex-1 bg-[#0d1117] text-white">
                          <div className="p-4 font-mono text-[11px] leading-relaxed">
                            {networkLogs.map((log) => {
                              let meta: any = {};
                              try { meta = JSON.parse(log.metadata || '{}'); } catch (e) {}
                              return (
                                <div 
                                  key={log.id} 
                                  onClick={() => setSelectedNetworkLog(log)}
                                  className={`flex gap-3 px-2 py-1 cursor-pointer hover:bg-white/5 border-b border-white/5 ${selectedNetworkLog?.id === log.id ? 'bg-white/10' : ''}`}
                                >
                                  <span className="text-muted-foreground shrink-0">{new Date(log.timestamp).toISOString().split('T')[1].split('.')[0]}</span>
                                  <span className={`shrink-0 w-[45px] font-bold ${
                                    meta.status >= 400 ? 'text-red-400' : 'text-green-400'
                                  }`}>
                                    {meta.method || 'GET'}
                                  </span>
                                  <span className={`shrink-0 w-[35px] ${
                                    meta.status >= 400 ? 'text-red-400' : 'text-green-400'
                                  }`}>
                                    {meta.status || '200'}
                                  </span>
                                  <span className="truncate flex-1">{meta.url || log.message}</span>
                                  <span className="text-muted-foreground shrink-0">{meta.duration ? `${meta.duration}ms` : ''}</span>
                                </div>
                              );
                            })}
                          </div>
                        </ScrollArea>
                        <div className="px-4 py-2 border-t border-border bg-card flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                          <div>
                            {networkTotal} requests recorded
                          </div>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setNetworkPage(p => Math.max(1, p - 1))} disabled={networkPage === 1}>
                              Prev
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setNetworkPage(p => p + 1)} disabled={networkPage * 50 >= networkTotal}>
                              Next
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* Network Details Pane */}
                      <AnimatePresence>
                        {selectedNetworkLog && (
                          <motion.div 
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: '33.333333%', opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            className="bg-card flex flex-col overflow-hidden border-l border-border"
                          >
                            <div className="p-3 border-b border-border flex justify-between items-center bg-muted/30">
                              <span className="font-semibold text-xs text-foreground uppercase tracking-wider">Request Details</span>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 rounded-full text-muted-foreground hover:text-foreground" onClick={() => setSelectedNetworkLog(null)}>
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                            <ScrollArea className="flex-1 p-4">
                              <div className="space-y-4 font-mono text-[11px]">
                                {(() => {
                                  let meta: any = {};
                                  try { meta = JSON.parse(selectedNetworkLog.metadata || '{}'); } catch (e) {}
                                  return (
                                    <>
                                      <div className="flex items-center gap-2 mb-4">
                                        <Badge variant="outline" className={meta.method === 'GET' ? 'text-primary border-primary/30' : 'text-primary border-primary/30'}>
                                          {meta.method || 'UNKNOWN'}
                                        </Badge>
                                        <Badge variant="outline" className={meta.status >= 500 ? 'text-destructive border-destructive/30' : meta.status >= 400 ? 'text-accent border-accent/30' : 'text-primary border-primary/30'}>
                                          {meta.status || '---'}
                                        </Badge>
                                        <span className="text-muted-foreground">{meta.duration ? `${meta.duration}ms` : ''}</span>
                                      </div>
                                      
                                      <div>
                                        <div className="text-muted-foreground mb-1">URL</div>
                                        <div className="text-foreground break-all bg-muted/50 p-2 rounded border border-border/50">{meta.url || selectedNetworkLog.message}</div>
                                      </div>
                                      
                                      <div>
                                        <div className="text-muted-foreground mb-1">Timestamp</div>
                                        <div className="text-foreground">{new Date(selectedNetworkLog.timestamp).toISOString()}</div>
                                      </div>

                                      {meta.ip && (
                                        <div>
                                          <div className="text-muted-foreground mb-1">Client IP</div>
                                          <div className="text-foreground">{meta.ip}</div>
                                        </div>
                                      )}
                                      
                                      {meta.userAgent && (
                                        <div>
                                          <div className="text-muted-foreground mb-1">User Agent</div>
                                          <div className="text-foreground text-[10px] break-all">{meta.userAgent}</div>
                                        </div>
                                      )}

                                      <Separator className="bg-border/50" />
                                      
                                      <div>
                                        <div className="text-muted-foreground mb-1">Raw Metadata</div>
                                        <pre className="bg-muted p-3 rounded-md border border-border text-primary overflow-x-auto">
                                          {JSON.stringify(meta, null, 2)}
                                        </pre>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>
                            </ScrollArea>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="settings" className="mt-0">
                  <div className="github-card">
                    <div className="github-card-header">
                      <div className="flex items-center gap-2">
                        <Settings className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm font-semibold">System Settings</span>
                      </div>
                    </div>
                    <div className="flex flex-col md:flex-row min-h-[700px]">
                      {/* Settings Sidebar */}
                      <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-border bg-muted">
                        <div className="p-4 space-y-1">
                          <Button variant="ghost" className="w-full justify-start text-xs font-semibold bg-primary/10 text-primary hover:bg-primary/20">General</Button>
                          <Button variant="ghost" className="w-full justify-start text-xs font-semibold text-muted-foreground hover:bg-muted/50">Access Control</Button>
                          <Button variant="ghost" className="w-full justify-start text-xs font-semibold text-muted-foreground hover:bg-muted/50">Notifications</Button>
                          <Button variant="ghost" className="w-full justify-start text-xs font-semibold text-muted-foreground hover:bg-muted/50">API & Integration</Button>
                          <Button variant="ghost" className="w-full justify-start text-xs font-semibold text-muted-foreground hover:bg-muted/50">Advanced</Button>
                        </div>
                      </div>

                      {/* Settings Content */}
                      <div className="flex-1 p-8 space-y-12">
                        <div className="space-y-6">
                          <div>
                            <h3 className="text-xl font-semibold mb-1">General Configuration</h3>
                            <p className="text-sm text-muted-foreground">Manage your core system preferences and synchronization schedules.</p>
                          </div>
                          
                          <Separator className="bg-border" />

                          <div className="space-y-8 max-w-2xl">
                            <div className="space-y-3">
                              <Label className="text-sm font-semibold">Cron Expression</Label>
                              <div className="flex gap-2">
                                <Input 
                                  value={settings.cronExpression || '0 0 1 * *'} 
                                  onChange={(e) => setSettings({ ...settings, cronExpression: e.target.value })}
                                  className="h-9 bg-card border-border font-mono text-sm" 
                                />
                                <Button 
                                  variant="outline" 
                                  onClick={() => updateSetting('cronExpression', settings.cronExpression)}
                                  className="h-9 text-xs font-semibold px-4 hover:bg-muted"
                                >
                                  Save
                                </Button>
                              </div>
                              <p className="text-[12px] text-muted-foreground">The schedule for automated data ingestion. Current: <code className="bg-muted px-1 rounded text-primary">{settings.cronExpression || '0 0 1 * *'}</code></p>
                            </div>

                            <div className="space-y-3">
                              <Label className="text-sm font-semibold">Log Retention (Days)</Label>
                              <Select 
                                value={settings.logRetentionDays || '0'} 
                                onValueChange={(val) => updateSetting('logRetentionDays', val)}
                              >
                                <SelectTrigger className="h-9 bg-card border-border text-sm">
                                  <SelectValue placeholder="Select retention" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="0">Forever</SelectItem>
                                  <SelectItem value="7">7 Days</SelectItem>
                                  <SelectItem value="30">30 Days</SelectItem>
                                  <SelectItem value="90">90 Days</SelectItem>
                                </SelectContent>
                              </Select>
                              <p className="text-[12px] text-muted-foreground">How long to keep system and network logs before automatic purging.</p>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-6">
                          <div>
                            <h3 className="text-xl font-semibold mb-1">System Status</h3>
                            <p className="text-sm text-muted-foreground">Real-time metrics of the underlying database and file system.</p>
                          </div>
                          
                          <Separator className="bg-border" />

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            <div className="p-4 bg-muted/30 border border-border rounded-md shadow-sm">
                              <div className="text-[11px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">DB Size</div>
                              <div className="text-xl font-mono font-bold text-foreground">{(systemStatus?.dbSize / 1024).toFixed(1)} KB</div>
                            </div>
                            <div className="p-4 bg-muted/30 border border-border rounded-md shadow-sm">
                              <div className="text-[11px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Files</div>
                              <div className="text-xl font-mono font-bold text-foreground">{systemStatus?.fileCount || 0}</div>
                            </div>
                            <div className="p-4 bg-muted/30 border border-border rounded-md shadow-sm">
                              <div className="text-[11px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Uptime</div>
                              <div className="text-xl font-mono font-bold text-foreground">99.98%</div>
                            </div>
                            <div className="p-4 bg-muted/30 border border-border rounded-md shadow-sm">
                              <div className="text-[11px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Version</div>
                              <div className="text-xl font-mono font-bold text-foreground">4.2.0</div>
                            </div>
                          </div>
                        </div>

                        <div className="pt-10">
                          <div className="border border-error/30 rounded-md overflow-hidden shadow-sm">
                            <div className="bg-error/5 px-4 py-3 border-b border-error/30">
                              <h3 className="text-sm font-bold text-error uppercase tracking-wider">Danger Zone</h3>
                            </div>
                            <div className="p-4 space-y-4 bg-card">
                              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                                <div>
                                  <div className="text-sm font-bold text-foreground">Purge All Data</div>
                                  <div className="text-xs text-muted-foreground">Permanently delete all sync runs, logs, and generated artifacts. This action cannot be undone.</div>
                                </div>
                                <Button 
                                  variant="outline" 
                                  onClick={purgeSystem}
                                  disabled={purging}
                                  className="h-8 text-xs font-bold text-error border-error/30 hover:bg-error hover:text-white transition-colors shrink-0"
                                >
                                  {purging ? 'Purging...' : 'Purge Data'}
                                </Button>
                              </div>
                              <Separator className="bg-border/50" />
                              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                                <div>
                                  <div className="text-sm font-bold text-foreground">Factory Reset</div>
                                  <div className="text-xs text-muted-foreground">Reset all configuration settings to their default values.</div>
                                </div>
                                <Button variant="outline" className="h-8 text-xs font-bold text-error border-error/30 hover:bg-error hover:text-white transition-colors shrink-0">
                                  Reset Settings
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>
            </motion.div>
          </AnimatePresence>
        </main>
      </Tabs>

      <Dialog open={!!selectedRun} onOpenChange={(open) => !open && setSelectedRun(null)}>
        <DialogContent className="max-w-[90vw] w-[1200px] h-[85vh] flex flex-col bg-card border-border p-0 overflow-hidden">
          <div className="github-card-header border-b border-border bg-muted/30">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold uppercase tracking-wider">Sync Run Details</span>
              {selectedRun && getStatusBadge(selectedRun.status)}
            </div>
          </div>
          
          {selectedRun && (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="p-6 border-b border-border bg-card">
                <div className="flex items-center justify-between mb-6">
                  <div className="text-xs text-muted-foreground">
                    Executed on <span className="text-foreground font-semibold">{new Date(selectedRun.timestamp).toLocaleString()}</span> via <span className="text-foreground font-semibold uppercase tracking-tight">{selectedRun.triggerType}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="p-4 bg-muted/30 border border-border rounded-md shadow-sm">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Items Parsed</div>
                    <div className="text-lg font-mono font-bold text-foreground">{selectedRun.totalItemsParsed}</div>
                  </div>
                  <div className="p-4 bg-muted/30 border border-border rounded-md shadow-sm">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase mb-2 tracking-wider">Files Generated</div>
                    <div className="text-lg font-mono font-bold text-foreground">{selectedRun.totalFilesGenerated}</div>
                  </div>
                </div>

                {selectedRun.errorSummary && (
                  <div className="mt-6 p-4 bg-error/5 border border-error/20 rounded-md text-error text-xs shadow-sm">
                    <span className="font-bold block mb-2 uppercase tracking-wider text-[10px]">Error Summary</span>
                    <div className="font-mono leading-relaxed">{selectedRun.errorSummary}</div>
                  </div>
                )}
              </div>

              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-muted/50 flex justify-between items-center">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Execution Logs</span>
                  {runLogsLoading && <RefreshCw className="w-3 h-3 animate-spin text-primary" />}
                </div>
                <div className="flex-1 overflow-y-auto bg-[#0d1117] text-white">
                  <div className="p-6 font-mono text-[11px] leading-relaxed">
                    {runLogsLoading ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-4">
                        <RefreshCw className="w-8 h-8 animate-spin text-primary opacity-50" />
                        <p className="text-muted-foreground font-mono animate-pulse">Fetching execution logs...</p>
                      </div>
                    ) : runLogs.length === 0 ? (
                      <div className="text-muted-foreground italic text-center py-10">No execution logs recorded for this run.</div>
                    ) : (
                      <div className="space-y-1.5">
                        {runLogs.map((log) => (
                          <div key={log.id} className="flex gap-4 px-2 py-1 hover:bg-white/5 rounded transition-colors group">
                            <span className="text-muted-foreground shrink-0 w-[70px]">{new Date(log.timestamp).toISOString().split('T')[1].replace('Z', '')}</span>
                            <span className={`shrink-0 w-[45px] font-bold ${
                              log.level === 'ERROR' ? 'text-red-400' : 
                              log.level === 'WARN' ? 'text-yellow-400' : 
                              'text-blue-400'
                            }`}>
                              {log.level}
                            </span>
                            <span className="break-all text-gray-300 group-hover:text-white transition-colors">{log.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={isGCSDialogOpen} onOpenChange={setIsGCSDialogOpen}>
        <DialogContent className="max-w-md bg-card border-border p-0 overflow-hidden">
          <div className="github-card-header border-b border-border bg-muted/30">
            <div className="flex items-center gap-3">
              <Cloud className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold uppercase tracking-wider">Export to GCS</span>
            </div>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsGCSDialogOpen(false)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          
          <div className="p-6 space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="projectId" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Google Cloud Project ID</Label>
                <Input 
                  id="projectId" 
                  placeholder="e.g. my-awesome-project" 
                  value={gcsProjectId} 
                  onChange={(e) => setGcsProjectId(e.target.value)}
                  className="bg-muted/30 border-border font-mono text-sm"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="bucketName" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Destination Bucket Name</Label>
                <Input 
                  id="bucketName" 
                  placeholder="e.g. gcp-datanator-backups" 
                  value={gcsBucketName} 
                  onChange={(e) => setGcsBucketName(e.target.value)}
                  className="bg-muted/30 border-border font-mono text-sm"
                />
              </div>
              
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <Label htmlFor="authCode" className="text-xs font-bold uppercase tracking-wider text-muted-foreground">OAuth Authorization Code</Label>
                  <a 
                    href="https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=postmessage&response_type=code&scope=https://www.googleapis.com/auth/devstorage.read_write&access_type=offline" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-[10px] text-primary hover:underline font-semibold"
                  >
                    Get Code
                  </a>
                </div>
                <Input 
                  id="authCode" 
                  placeholder="Paste your auth code here..." 
                  value={gcsAuthCode} 
                  onChange={(e) => setGcsAuthCode(e.target.value)}
                  className="bg-muted/30 border-border font-mono text-sm"
                />
                <p className="text-[10px] text-muted-foreground italic">
                  Note: You need to provide a valid OAuth code with GCS write permissions.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setIsGCSDialogOpen(false)} className="text-xs font-semibold">
                Cancel
              </Button>
              <Button 
                variant="default" 
                size="sm" 
                onClick={handleGCSExport} 
                disabled={isExporting || !gcsProjectId || !gcsBucketName || !gcsAuthCode}
                className="text-xs font-bold uppercase tracking-wider bg-primary hover:bg-primary/90"
              >
                {isExporting ? (
                  <>
                    <RefreshCw className="w-3 h-3 mr-2 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Cloud className="w-3 h-3 mr-2" />
                    Start Export
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
