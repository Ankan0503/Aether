import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Settings, 
  Cpu, 
  Wifi, 
  Trash2, 
  Plus, 
  Key, 
  User as UserIcon, 
  LogOut, 
  PlusCircle, 
  RefreshCw,
  Layers,
  Radio,
  Bell,
  BellRing,
  Smartphone
} from 'lucide-react';
import {
  getPushStatus,
  sendTestNotification,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
  type PushStatus
} from '../services/pwaService';

interface SettingsViewProps {
  isAuthenticated: boolean;
  setIsAuthenticated: (v: boolean) => void;
  username: string;
  setUsername: (v: string) => void;
  meshId: string;
  setMeshId: (v: string) => void;
  meshKey: string;
  setMeshKey: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
}

export const SettingsView = ({
  isAuthenticated,
  setIsAuthenticated,
  username,
  setUsername,
  meshId,
  setMeshId,
  meshKey,
  setMeshKey,
  token,
  setToken
}: SettingsViewProps) => {
  
  const [devices, setDevices] = useState<any[]>([]);
  const [unlinkedDevices, setUnlinkedDevices] = useState<any[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const [authTab, setAuthTab] = useState<'login' | 'signup'>('login');
  const [inputUsername, setInputUsername] = useState('');
  const [inputPassword, setInputPassword] = useState('');
  const [inputEmail, setInputEmail] = useState('');
  
  const [authError, setAuthError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  // Pairing inputs state (keyed by MAC address)
  const [pairingUniques, setPairingUniques] = useState<{[key: string]: string}>({});
  const [pairingDisplays, setPairingDisplays] = useState<{[key: string]: string}>({});
  const [pairingRoles, setPairingRoles] = useState<{[key: string]: string}>({});

  // Deletion confirmation modal states
  const [deviceToDelete, setDeviceToDelete] = useState<any | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [gatewayCheckboxChecked, setGatewayCheckboxChecked] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Appliance editing states
  const [editingApplianceId, setEditingApplianceId] = useState<number | null>(null);
  const [editAppName, setEditAppName] = useState('');
  const [editAppType, setEditAppType] = useState('Appliance');
  const [editAppConsumption, setEditAppConsumption] = useState(100);
  const [isSavingAppliance, setIsSavingAppliance] = useState(false);

  const handleSaveAppliance = async (appId: number) => {
    setIsSavingAppliance(true);
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(`${API_URL}/api/devices/appliance/update/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          appliance_id: appId,
          name: editAppName,
          type: editAppType,
          nominal_consumption: editAppConsumption
        })
      });
      if (res.ok) {
        setEditingApplianceId(null);
        fetchDevices();
      } else {
        alert("Failed to save socket configuration.");
      }
    } catch (e) {
      console.error("Save appliance failed:", e);
    } finally {
      setIsSavingAppliance(false);
    }
  };

  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const [pushStatus, setPushStatus] = useState<PushStatus>({
    supported: false,
    permission: 'unsupported',
    subscribed: false,
    configured: false
  });
  const [pushMessage, setPushMessage] = useState('');
  const [isPushBusy, setIsPushBusy] = useState(false);

  const refreshPushStatus = async () => {
    const status = await getPushStatus();
    setPushStatus(status);
  };

  const checkAuth = async () => {
    const saved = localStorage.getItem('aether_user');
    let currentToken = token;
    if (saved) {
      try {
        const user = JSON.parse(saved);
        setIsAuthenticated(true);
        setUsername(user.username);
        setMeshId(user.mesh_id);
        setMeshKey(user.mesh_key);
        currentToken = user.token || token;
        if (currentToken && currentToken !== token) {
          setToken(currentToken);
        }
        fetchDevices(currentToken);
        fetchUnlinkedDevices(currentToken);
        return; // Skip server check if cached
      } catch (e) {
        console.error("Failed to parse cached auth:", e);
      }
    }

    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (currentToken) {
        headers['Authorization'] = `Bearer ${currentToken}`;
      }
      const res = await fetch(`${API_URL}/api/accounts/me/`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          setIsAuthenticated(true);
          setUsername(data.username);
          setMeshId(data.mesh_id);
          setMeshKey(data.mesh_key);
          localStorage.setItem('aether_user', JSON.stringify({
            token: currentToken,
            username: data.username,
            mesh_id: data.mesh_id,
            mesh_key: data.mesh_key
          }));
          fetchDevices(currentToken);
          fetchUnlinkedDevices(currentToken);
        }
      } else {
        setIsAuthenticated(false);
      }
    } catch (e) {
      console.error("Auth check failed:", e);
    }
  };

  const fetchDevices = async (tokenOverride?: string) => {
    try {
      const activeToken = tokenOverride || token;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
      }
      const res = await fetch(`${API_URL}/api/devices/?mesh_id=${meshId}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
      }
    } catch (e) {
      console.error("Failed to fetch devices:", e);
    }
  };

  const fetchUnlinkedDevices = async (tokenOverride?: string) => {
    try {
      const activeToken = tokenOverride || token;
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
      }
      const res = await fetch(`${API_URL}/api/devices/unlinked/?mesh_id=${meshId}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setUnlinkedDevices(data.devices || []);
      }
    } catch (e) {
      console.error("Failed to fetch unlinked devices:", e);
    }
  };

  useEffect(() => {
    checkAuth();
    // Poll unlinked devices every 4 seconds
    const interval = setInterval(() => {
      if (isAuthenticated) {
        fetchUnlinkedDevices();
        fetchDevices();
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [isAuthenticated, token]);

  useEffect(() => {
    if (isAuthenticated) {
      refreshPushStatus().catch((err) => {
        console.error("Failed to inspect push status:", err);
      });
    }
  }, [isAuthenticated]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setIsLoading(true);
    
    const endpoint = authTab === 'login' ? 'login/' : 'signup/';
    const body = authTab === 'login' 
      ? { username: inputUsername, password: inputPassword }
      : { username: inputUsername, password: inputPassword, email: inputEmail };

    try {
      const res = await fetch(`${API_URL}/api/accounts/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        setIsAuthenticated(true);
        setUsername(data.username);
        setMeshId(data.mesh_id);
        setMeshKey(data.mesh_key);
        setToken(data.token);
        localStorage.setItem('aether_user', JSON.stringify({
          token: data.token,
          username: data.username,
          mesh_id: data.mesh_id,
          mesh_key: data.mesh_key
        }));
        setInputPassword('');
        fetchDevices(data.token);
        fetchUnlinkedDevices(data.token);
      } else {
        setAuthError(data.error || 'Authentication failed.');
      }
    } catch (e) {
      setAuthError('Network error. Is backend running?');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      await fetch(`${API_URL}/api/accounts/logout/`, { method: 'POST', headers });
      setIsAuthenticated(false);
      setUsername('');
      setMeshId('');
      setMeshKey('');
      setToken('');
      setDevices([]);
      setUnlinkedDevices([]);
      localStorage.removeItem('aether_user');
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  const handlePair = async (mac: string) => {
    const uniqueSuffix = pairingUniques[mac] || 'node';
    const friendlyName = pairingDisplays[mac] || 'Sensor';
    const name = `aether-${uniqueSuffix}-${friendlyName}`;
    const role = pairingRoles[mac] || 'sensor';

    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(`${API_URL}/api/devices/register/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mac_address: mac, name, role, mesh_id: meshId })
      });
      if (res.ok) {
        // Clear pairing input fields
        setPairingUniques(prev => {
          const next = { ...prev };
          delete next[mac];
          return next;
        });
        setPairingDisplays(prev => {
          const next = { ...prev };
          delete next[mac];
          return next;
        });
        fetchDevices();
        fetchUnlinkedDevices();
      }
    } catch (e) {
      console.error("Pairing failed:", e);
    }
  };

  const handleUnpair = async () => {
    if (!deviceToDelete) return;
    setIsDeleting(true);
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch(`${API_URL}/api/devices/unregister/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mac_address: deviceToDelete.mac_address, mesh_id: meshId })
      });
      if (res.ok) {
        fetchDevices();
        fetchUnlinkedDevices();
        setDeviceToDelete(null);
        setDeleteConfirmText('');
        setGatewayCheckboxChecked(false);
      } else {
        const errData = await res.json();
        alert(errData.error || "Unpairing failed.");
      }
    } catch (e) {
      console.error("Unpairing failed:", e);
      alert("Network error occurred during unpairing.");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await Promise.all([fetchDevices(), fetchUnlinkedDevices()]);
    setTimeout(() => setIsRefreshing(false), 600);
  };

  const handleEnablePush = async () => {
    setIsPushBusy(true);
    setPushMessage('');
    try {
      await subscribeToPushNotifications(token);
      await refreshPushStatus();
      setPushMessage('Push channel armed for this browser.');
    } catch (err: any) {
      setPushMessage(err.message || 'Unable to enable push notifications.');
      await refreshPushStatus().catch(() => undefined);
    } finally {
      setIsPushBusy(false);
    }
  };

  const handleDisablePush = async () => {
    setIsPushBusy(true);
    setPushMessage('');
    try {
      await unsubscribeFromPushNotifications(token);
      await refreshPushStatus();
      setPushMessage('Push channel disabled for this browser.');
    } catch (err: any) {
      setPushMessage(err.message || 'Unable to disable push notifications.');
    } finally {
      setIsPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    setIsPushBusy(true);
    setPushMessage('');
    try {
      const result = await sendTestNotification(token);
      setPushMessage(result.sent > 0 ? 'Test notification sent.' : 'No active browser subscriptions found.');
    } catch (err: any) {
      setPushMessage(err.message || 'Test notification failed.');
    } finally {
      setIsPushBusy(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md bg-white rounded-[1.75rem] sm:rounded-[3.5rem] p-5 sm:p-10 border border-olive/15 shadow-2xl mx-auto mt-4 sm:mt-10 relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-olive via-sage to-clay" />
        <div className="flex flex-col items-center mb-8">
          <div className="p-4 bg-olive/10 text-olive rounded-3xl mb-4">
            <Radio size={28} className="animate-pulse" />
          </div>
          <h3 className="text-xl font-display font-medium text-olive italic">Aether Mesh Sentinel</h3>
          <p className="text-[10px] text-ink/40 font-black uppercase tracking-widest mt-1">Authentication Core Gate</p>
        </div>

        <div className="flex border-b border-olive/10 mb-6">
          <button 
            onClick={() => { setAuthTab('login'); setAuthError(''); }}
            className={`flex-1 pb-3 text-[10px] font-black uppercase tracking-widest transition-all ${authTab === 'login' ? 'border-b-2 border-olive text-olive' : 'text-ink/30'}`}
          >
            Sign In
          </button>
          <button 
            onClick={() => { setAuthTab('signup'); setAuthError(''); }}
            className={`flex-1 pb-3 text-[10px] font-black uppercase tracking-widest transition-all ${authTab === 'signup' ? 'border-b-2 border-olive text-olive' : 'text-ink/30'}`}
          >
            Create Mesh
          </button>
        </div>

        <form onSubmit={handleAuth} className="space-y-4">
          <div>
            <label className="text-[9px] font-black text-olive/50 uppercase tracking-widest block mb-1">Username</label>
            <input 
              type="text" 
              value={inputUsername}
              onChange={e => setInputUsername(e.target.value)}
              className="w-full px-4 py-3 bg-bg-card/25 border border-olive/10 rounded-2xl text-xs font-bold text-ink focus:outline-none focus:border-olive transition-colors"
              required 
            />
          </div>

          {authTab === 'signup' && (
            <div>
              <label className="text-[9px] font-black text-olive/50 uppercase tracking-widest block mb-1">Email (Optional)</label>
              <input 
                type="email" 
                value={inputEmail}
                onChange={e => setInputEmail(e.target.value)}
                className="w-full px-4 py-3 bg-bg-card/25 border border-olive/10 rounded-2xl text-xs font-bold text-ink focus:outline-none focus:border-olive transition-colors"
              />
            </div>
          )}

          <div>
            <label className="text-[9px] font-black text-olive/50 uppercase tracking-widest block mb-1">Password</label>
            <input 
              type="password" 
              value={inputPassword}
              onChange={e => setInputPassword(e.target.value)}
              className="w-full px-4 py-3 bg-bg-card/25 border border-olive/10 rounded-2xl text-xs font-bold text-ink focus:outline-none focus:border-olive transition-colors"
              required 
            />
          </div>

          {authError && (
            <div className="p-3 bg-danger/10 border border-danger/10 rounded-2xl text-[10px] text-danger font-bold italic text-center">
              {authError}
            </div>
          )}

          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full py-4 bg-olive text-white rounded-2xl text-[10px] font-black uppercase tracking-wider sm:tracking-widest shadow-lg shadow-olive/10 hover:bg-olive/90 transition-all flex items-center justify-center gap-2"
          >
            {isLoading ? <RefreshCw size={14} className="animate-spin" /> : null}
            {authTab === 'login' ? 'ESTABLISH MESH CHANNEL' : 'PROVISION NEW MESH NETWORK'}
          </button>
        </form>
      </motion.div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="max-w-4xl bg-white rounded-[1.75rem] sm:rounded-[3rem] 2xl:rounded-[4rem] p-4 sm:p-6 lg:p-10 border border-olive/10 shadow-sm mx-auto pb-20 space-y-8 sm:space-y-12"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-olive/5 pb-6 sm:pb-8">
        <div className="flex items-center gap-4 sm:gap-6">
          <div className="p-4 sm:p-5 bg-olive text-white rounded-2xl sm:rounded-3xl soft-shadow">
            <Settings size={24} />
          </div>
          <div>
            <h3 className="text-xl sm:text-2xl font-display font-medium text-olive italic leading-tight sm:leading-none">System Preference Matrix</h3>
            <p className="text-[10px] text-ink/30 font-black uppercase mt-1.5 tracking-widest">Mesh Configuration Dashboard</p>
          </div>
        </div>
        
        <button 
          onClick={handleLogout}
          className="w-full sm:w-auto px-5 py-3 border border-danger/10 text-danger hover:bg-danger/5 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
        >
          <LogOut size={12} />
          Terminate Session
        </button>
      </div>

      {/* Mesh Configuration Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="p-4 sm:p-6 bg-olive/5 rounded-2xl sm:rounded-3xl border border-olive/5 flex items-start gap-4 min-w-0">
          <div className="p-3 bg-olive/10 text-olive rounded-2xl">
            <Layers size={20} />
          </div>
          <div>
            <h4 className="text-[9px] font-black text-olive/40 uppercase tracking-widest mb-1">Mesh Identifier</h4>
            <div className="text-xs sm:text-sm font-bold text-ink italic font-mono selection:bg-olive/20 break-all">{meshId}</div>
            <p className="text-[8px] text-ink/40 font-bold uppercase tracking-wider mt-1">Required for ESP32 configuration</p>
          </div>
        </div>

        <div className="p-4 sm:p-6 bg-olive/5 rounded-2xl sm:rounded-3xl border border-olive/5 flex items-start gap-4 min-w-0">
          <div className="p-3 bg-olive/10 text-olive rounded-2xl">
            <Key size={20} />
          </div>
          <div>
            <h4 className="text-[9px] font-black text-olive/40 uppercase tracking-widest mb-1">Mesh Secret Key</h4>
            <div className="text-xs sm:text-sm font-bold text-ink italic font-mono selection:bg-olive/20 select-all break-all">{meshKey}</div>
            <p className="text-[8px] text-ink/40 font-bold uppercase tracking-wider mt-1">Do not share. Secures peer-to-peer ESP-NOW</p>
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-6 bg-bg-card/20 rounded-2xl sm:rounded-3xl border border-olive/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className={`p-3 rounded-2xl ${pushStatus.subscribed ? 'bg-sage/15 text-sage' : 'bg-olive/10 text-olive'}`}>
            {pushStatus.subscribed ? <BellRing size={20} /> : <Bell size={20} />}
          </div>
          <div>
            <h4 className="text-[9px] font-black text-olive/50 uppercase tracking-widest mb-1">Browser Push Channel</h4>
            <div className="text-sm font-bold text-ink italic">
              {pushStatus.subscribed ? 'Enabled' : pushStatus.permission === 'denied' ? 'Blocked' : 'Not Enabled'}
            </div>
            <p className="text-[8px] text-ink/40 font-bold uppercase tracking-wider mt-1">
              {pushStatus.supported
                ? pushStatus.configured ? 'PWA service worker linked to Django Web Push' : 'Backend VAPID keys required'
                : 'Requires HTTPS, localhost, and Push API support'}
            </p>
            {pushMessage && (
              <p className="text-[9px] text-olive/60 font-bold italic mt-2">{pushMessage}</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-3 w-full md:w-auto">
          <button
            type="button"
            onClick={pushStatus.subscribed ? handleDisablePush : handleEnablePush}
            disabled={isPushBusy || !pushStatus.supported || !pushStatus.configured || pushStatus.permission === 'denied'}
            className={`px-5 py-3 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${
              pushStatus.subscribed
                ? 'border border-danger/10 text-danger hover:bg-danger/5'
                : 'bg-olive text-white shadow-lg shadow-olive/10 hover:bg-olive/90'
            } disabled:bg-ink/10 disabled:text-ink/30 disabled:border-transparent disabled:shadow-none`}
          >
            {isPushBusy ? <RefreshCw size={12} className="animate-spin" /> : <Smartphone size={12} />}
            {pushStatus.subscribed ? 'Disable Push' : 'Enable Push'}
          </button>
          <button
            type="button"
            onClick={handleTestPush}
            disabled={isPushBusy || !pushStatus.subscribed}
            className="px-5 py-3 border border-olive/10 text-olive hover:bg-olive/5 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-2 disabled:text-ink/30 disabled:bg-ink/5"
          >
            <Bell size={12} />
            Test
          </button>
        </div>
      </div>

      {/* Active Device Discovery Alert Card */}
      {unlinkedDevices.length > 0 && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
        className="p-4 sm:p-8 rounded-[1.75rem] sm:rounded-[2.5rem] bg-gradient-to-br from-sage/10 to-olive/5 border border-sage/30 shadow-sm relative overflow-hidden"
        >
          <div className="absolute top-0 right-0 w-24 h-24 bg-sage/20 rounded-full blur-2xl translate-x-6 -translate-y-6" />
          <div className="flex items-center gap-4 mb-6">
            <div className="w-2.5 h-2.5 rounded-full bg-sage animate-ping" />
            <div>
              <h4 className="text-xs font-black text-olive uppercase tracking-widest">Unassigned Devices Detected</h4>
              <p className="text-[9px] text-ink/40 font-bold italic mt-0.5">Found new ESP32 units broadcasting discovery signatures locally</p>
            </div>
          </div>

          <div className="space-y-4">
            {unlinkedDevices.map((dev) => (
              <div 
                key={dev.mac_address}
                className="p-4 sm:p-5 bg-white rounded-2xl sm:rounded-3xl border border-olive/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 transition-all hover:shadow-md"
              >
                <div>
                  <div className="text-xs font-mono font-bold text-ink">{dev.mac_address}</div>
                  <div className="text-[8px] text-ink/30 font-black uppercase tracking-wider mt-0.5">Discovered via Central Gateway</div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex flex-1 max-w-lg items-center gap-3 w-full">
                  <div className="flex items-center bg-bg-card/25 border border-olive/10 rounded-xl px-3 py-1 flex-1 min-w-0 sm:min-w-[120px]">
                    <span className="text-[10px] font-bold text-olive/40 select-none">aether-</span>
                    <input 
                      type="text"
                      placeholder="room1"
                      maxLength={20}
                      value={pairingUniques[dev.mac_address] || ''}
                      onChange={e => setPairingUniques({ ...pairingUniques, [dev.mac_address]: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                      className="w-full bg-transparent border-none text-[10px] font-bold text-ink focus:outline-none py-1.5"
                    />
                  </div>
                  <input 
                    type="text"
                    placeholder="E.g., Kitchen Gas Sensor"
                    maxLength={30}
                    value={pairingDisplays[dev.mac_address] || ''}
                    onChange={e => setPairingDisplays({ ...pairingDisplays, [dev.mac_address]: e.target.value })}
                    className="flex-1 px-4 py-2.5 bg-bg-card/25 border border-olive/10 rounded-xl text-[10px] font-bold text-ink focus:outline-none focus:border-olive min-w-0 sm:min-w-[150px]"
                  />
                  <select
                    value={pairingRoles[dev.mac_address] || 'sensor'}
                    onChange={e => setPairingRoles({ ...pairingRoles, [dev.mac_address]: e.target.value })}
                    className="px-3 py-2.5 bg-bg-card/25 border border-olive/10 rounded-xl text-[10px] font-bold text-ink focus:outline-none"
                  >
                    <option value="sensor">Sensor Node</option>
                    <option value="relay">Relay Node</option>
                    <option value="gateway">Central Gateway</option>
                  </select>
                </div>

                <button 
                  onClick={() => handlePair(dev.mac_address)}
                  className="px-5 py-3 bg-olive text-white rounded-xl text-[9px] font-black uppercase tracking-widest shadow-sm hover:bg-olive/90 transition-all flex items-center gap-2 w-full md:w-auto justify-center"
                >
                  <Plus size={12} />
                  Authorize Device
                </button>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Paired Device List Table */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-black text-ink uppercase tracking-widest">Active Mesh Nodes</h4>
            <p className="text-[9px] text-ink/30 font-bold italic mt-0.5">List of devices cryptographically bound to your mesh network</p>
          </div>
          <button 
            onClick={handleManualRefresh}
            className="p-2.5 bg-bg-card/30 hover:bg-bg-card rounded-xl text-ink/40 hover:text-ink transition-colors"
            title="Refresh List"
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin text-olive" : ""} />
          </button>
        </div>

        {devices.length === 0 ? (
          <div className="p-8 text-center bg-bg-card/10 rounded-3xl border border-dashed border-olive/10">
            <Wifi size={24} className="text-ink/10 mx-auto mb-2" />
            <p className="text-[10px] text-ink/40 font-bold italic">No devices paired to this mesh yet.</p>
          </div>
        ) : (
          <div className="bg-bg-card/10 border border-olive/5 rounded-2xl sm:rounded-3xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-olive/5 text-[9px] font-black text-olive/50 uppercase tracking-widest bg-olive/5">
                    <th className="p-4 pl-6">Device Name</th>
                    <th className="p-4">MAC Address</th>
                    <th className="p-4">Role</th>
                    <th className="p-4 text-center">Status</th>
                    <th className="p-4 text-right pr-6">Management</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-olive/5 text-[10px] font-bold text-ink">
                  {devices.map((dev) => (
                    <React.Fragment key={dev.mac_address}>
                      <tr className="hover:bg-white/50 transition-colors">
                        <td className="p-4 pl-6 italic">{dev.name}</td>
                        <td className="p-4 font-mono font-medium">{dev.mac_address}</td>
                        <td className="p-4">
                          <span className={`px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-wider border ${
                            dev.role === 'gateway' ? 'bg-olive/10 text-olive border-olive/10' :
                            dev.role === 'relay' ? 'bg-clay/10 text-clay border-clay/10' :
                            'bg-sage/10 text-sage border-sage/10'
                          }`}>
                            {dev.role}
                          </span>
                        </td>
                        <td className="p-4 text-center">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[8px] font-black uppercase tracking-wider border transition-all ${
                            dev.is_active 
                              ? 'bg-sage/10 text-sage border-sage/20 shadow-sm shadow-sage/5 animate-pulse' 
                              : 'bg-danger/5 text-danger/60 border-danger/10'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${dev.is_active ? 'bg-sage' : 'bg-danger/40'}`} />
                            {dev.is_active ? 'Active' : 'Offline'}
                          </span>
                        </td>
                        <td className="p-4 text-right pr-6">
                          <button 
                            onClick={() => {
                              setDeviceToDelete(dev);
                              setDeleteConfirmText('');
                              setGatewayCheckboxChecked(false);
                            }}
                            className={`p-2 rounded-lg transition-all ${
                              dev.role === 'gateway' 
                                ? 'text-danger hover:bg-danger/10 border border-danger/25 shadow-sm' 
                                : 'text-ink/20 hover:text-danger hover:bg-danger/5'
                            }`}
                            title={dev.role === 'gateway' ? "Deregister Mesh & Gateway" : "Remove from Mesh"}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                      {dev.role === 'relay' && dev.appliances && dev.appliances.length > 0 && (
                        <tr className="bg-bg-card/25 border-b border-olive/5">
                          <td colSpan={5} className="p-6 pl-10 pr-10">
                            <div className="text-[9px] font-black text-olive/40 uppercase tracking-widest mb-3">Socket Configurations</div>
                            <div className="space-y-4">
                              {dev.appliances.map((app: any) => (
                                <div key={app.id} className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-4 bg-white/70 border border-olive/5 rounded-2xl">
                                  <div className="flex-1">
                                    {editingApplianceId === app.id ? (
                                      <div className="flex flex-wrap gap-3 items-center w-full">
                                        <input
                                          type="text"
                                          value={editAppName}
                                          onChange={(e) => setEditAppName(e.target.value)}
                                          className="px-3 py-1.5 bg-bg-card/25 border border-olive/10 rounded-xl text-[10px] font-bold text-ink focus:outline-none focus:border-olive flex-1 min-w-[150px]"
                                          placeholder="Socket Name"
                                        />
                                        <select
                                          value={editAppType}
                                          onChange={(e) => setEditAppType(e.target.value)}
                                          className="px-2 py-1.5 bg-bg-card/25 border border-olive/10 rounded-xl text-[10px] font-bold text-ink focus:outline-none"
                                        >
                                          <option value="Lights">Lights</option>
                                          <option value="Appliance">Appliance</option>
                                          <option value="HVAC">HVAC</option>
                                          <option value="Samsung TV">Samsung TV</option>
                                        </select>
                                        <input
                                          type="number"
                                          value={editAppConsumption}
                                          onChange={(e) => setEditAppConsumption(Number(e.target.value))}
                                          className="px-3 py-1.5 bg-bg-card/25 border border-olive/10 rounded-xl text-[10px] font-bold text-ink focus:outline-none focus:border-olive w-20"
                                          placeholder="W"
                                        />
                                        <div className="flex gap-2">
                                          <button
                                            onClick={() => handleSaveAppliance(app.id)}
                                            disabled={isSavingAppliance}
                                            className="px-4 py-1.5 bg-olive text-white rounded-xl hover:bg-olive/90 transition-all text-[9px] font-black uppercase tracking-wider"
                                          >
                                            Save
                                          </button>
                                          <button
                                            onClick={() => setEditingApplianceId(null)}
                                            className="px-4 py-1.5 border border-olive/10 text-ink/40 rounded-xl hover:bg-bg-card transition-all text-[9px] font-black uppercase tracking-wider"
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-center justify-between w-full">
                                        <div>
                                          <span className="text-[9px] text-olive font-black tracking-wider uppercase bg-olive/10 px-2 py-0.5 rounded-full mr-3">Channel {app.channel}</span>
                                          <span className="font-bold text-ink italic mr-4">{app.name}</span>
                                          <span className="text-ink/40 text-[9px] tracking-wide uppercase mr-4">{app.type}</span>
                                          <span className="text-ink/30 text-[9px] font-mono font-medium">{app.nominal_consumption}W</span>
                                        </div>
                                        <button
                                          onClick={() => {
                                            setEditingApplianceId(app.id);
                                            setEditAppName(app.name);
                                            setEditAppType(app.type);
                                            setEditAppConsumption(app.nominal_consumption);
                                          }}
                                          className="px-4 py-1.5 border border-olive/10 text-olive hover:bg-olive/5 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all"
                                        >
                                          Configure
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Custom Deletion Confirmation Modal */}
      <AnimatePresence>
        {deviceToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (!isDeleting) {
                  setDeviceToDelete(null);
                }
              }}
              className="absolute inset-0 bg-ink/40 backdrop-blur-md"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', duration: 0.4 }}
              className="relative w-full max-w-md bg-white rounded-[1.75rem] sm:rounded-[3.5rem] p-5 sm:p-10 border border-olive/15 shadow-2xl overflow-hidden z-10 max-h-[92vh] overflow-y-auto"
            >
              {/* Top Warning Strip */}
              <div className={`absolute top-0 left-0 w-full h-2 ${
                deviceToDelete.role === 'gateway' ? 'bg-danger' : 'bg-clay'
              }`} />

              <div className="flex flex-col items-center text-center">
                {/* Warning Icon */}
                <div className={`p-4 rounded-3xl mb-5 ${
                  deviceToDelete.role === 'gateway' ? 'bg-danger/10 text-danger' : 'bg-clay/10 text-clay'
                }`}>
                  <Trash2 size={28} className={deviceToDelete.role === 'gateway' ? 'animate-bounce' : ''} />
                </div>

                <h3 className={`text-xl font-display font-medium italic mb-2 ${
                  deviceToDelete.role === 'gateway' ? 'text-danger' : 'text-olive'
                }`}>
                  {deviceToDelete.role === 'gateway' ? 'DISSOLVE SECURE MESH' : 'REMOVE NODE FROM MESH'}
                </h3>
                
                <p className="text-[10px] text-ink/40 font-black uppercase tracking-widest mb-6">
                  {deviceToDelete.role === 'gateway' ? 'Critical Network Destruction' : 'Node De-authorization Gate'}
                </p>

                {/* Device Info */}
                <div className="w-full bg-olive/5 rounded-2xl p-4 border border-olive/5 mb-6 text-left space-y-2">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="font-black text-olive/50 uppercase tracking-wider">Device Name:</span>
                    <span className="font-mono font-bold text-ink italic">{deviceToDelete.name}</span>
                  </div>
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="font-black text-olive/50 uppercase tracking-wider">MAC Address:</span>
                    <span className="font-mono font-bold text-ink">{deviceToDelete.mac_address}</span>
                  </div>
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="font-black text-olive/50 uppercase tracking-wider">Role:</span>
                    <span className="font-mono font-bold text-ink uppercase">{deviceToDelete.role}</span>
                  </div>
                </div>

                {/* WARNING MESSAGE */}
                {deviceToDelete.role === 'gateway' ? (
                  <div className="w-full bg-danger/10 border border-danger/20 rounded-2xl p-5 mb-6 text-left text-danger">
                    <p className="text-xs font-black uppercase tracking-wider mb-1.5">🚨 CRITICAL DANGER ZONE</p>
                    <p className="text-[10px] font-bold leading-relaxed">
                      De-authorizing the Central Gateway will dissolve the entire secure mesh network. 
                      This will delete <strong>ALL ({devices.length})</strong> connected nodes and their histories from the database. 
                      The Central Gateway and all sub-nodes will be reset to factory settings.
                    </p>
                    
                    {/* Mandatory Checkbox */}
                    <label className="flex items-start gap-2.5 mt-4 select-none cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={gatewayCheckboxChecked}
                        onChange={(e) => setGatewayCheckboxChecked(e.target.checked)}
                        className="mt-0.5 rounded border-danger/30 text-danger focus:ring-danger"
                      />
                      <span className="text-[9px] font-black uppercase tracking-wide text-danger leading-tight">
                        I understand that this action is irreversible and will delete all other devices in my mesh
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="w-full bg-clay/5 border border-clay/10 rounded-2xl p-4 mb-6 text-left text-ink/70">
                    <p className="text-[10px] font-medium leading-relaxed">
                      Removing this sensor node will permanently delete it and all its associated telemetry logs from the database. 
                      An unpair command will be sent, and the hardware will return to Discovery Mode.
                    </p>
                  </div>
                )}

                {/* Typing Reverification Field */}
                <div className="w-full text-left mb-6">
                  <label className="text-[9px] font-black text-olive/50 uppercase tracking-widest block mb-1">
                    To confirm, please type <span className="text-danger font-bold">DELETE</span>:
                  </label>
                  <input
                    type="text"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value.toUpperCase())}
                    placeholder="Type 'DELETE'"
                    disabled={isDeleting}
                    className="w-full px-4 py-3 bg-bg-card/25 border border-olive/10 rounded-2xl text-xs font-bold text-ink focus:outline-none focus:border-danger transition-colors text-center font-mono placeholder:font-sans placeholder:italic placeholder:font-normal uppercase"
                  />
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 w-full">
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => setDeviceToDelete(null)}
                    className="flex-1 py-3.5 border border-olive/10 text-olive/60 hover:bg-olive/5 rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      isDeleting ||
                      deleteConfirmText !== 'DELETE' ||
                      (deviceToDelete.role === 'gateway' && !gatewayCheckboxChecked)
                    }
                    onClick={handleUnpair}
                    className={`flex-1 py-3.5 text-white rounded-2xl text-[9px] font-black uppercase tracking-widest transition-all shadow-lg hover:shadow-xl flex items-center justify-center gap-2 ${
                      deleteConfirmText === 'DELETE' && (deviceToDelete.role !== 'gateway' || gatewayCheckboxChecked)
                        ? 'bg-danger shadow-danger/10 hover:bg-danger/90'
                        : 'bg-ink/10 text-ink/30 cursor-not-allowed shadow-none border border-ink/5'
                    }`}
                  >
                    {isDeleting ? <RefreshCw size={12} className="animate-spin" /> : null}
                    Execute Deletion
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
