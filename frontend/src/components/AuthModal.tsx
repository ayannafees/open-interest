import React, { useState } from 'react';
import {
    LogIn,
    UserPlus,
    Shield,
    User,
    Lock,
    X,
    AlertCircle,
    CheckCircle2,
    ShieldAlert,
    UserCheck,
    Activity,
    Cpu,
    LockKeyhole
} from 'lucide-react';

interface AuthModalProps {
    isOpen: boolean;
    isFullScreen?: boolean;
    onClose?: () => void;
    onAuthSuccess: (token: string, user: { id: string; username: string; role: string }) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
    isOpen,
    isFullScreen = false,
    onClose,
    onAuthSuccess
}) => {
    const [mode, setMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');

    // Role selection: 'TRADER' vs 'ADMIN'
    const [selectedRole, setSelectedRole] = useState<'TRADER' | 'ADMIN'>('TRADER');

    // Login Form State
    const [loginUsername, setLoginUsername] = useState('');
    const [loginPassword, setLoginPassword] = useState('');

    // Register Form State
    const [regUsername, setRegUsername] = useState('');
    const [regPassword, setRegPassword] = useState('');
    const [regConfirmPassword, setRegConfirmPassword] = useState('');

    // Status / Feedback
    const [isLoading, setIsLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    if (!isOpen) return null;

    const handleLoginSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrorMsg(null);
        setSuccessMsg(null);

        if (!loginUsername.trim() || !loginPassword) {
            setErrorMsg('Username and password are required');
            return;
        }

        setIsLoading(true);
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: loginUsername.trim(),
                    password: loginPassword,
                    role: selectedRole,
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                if (data.error === 'ROLE_MISMATCH') {
                    setErrorMsg(data.message || `Account role does not match selected role (${selectedRole})`);
                } else if (data.error === 'INVALID_CREDENTIALS') {
                    setErrorMsg('Invalid username or password');
                } else {
                    setErrorMsg(data.error || 'Authentication failed');
                }
                setIsLoading(false);
                return;
            }

            const token = data.token;
            const user = data.user || data.trader;
            setSuccessMsg(`Authenticated as ${user.role}: ${user.username}`);
            setTimeout(() => {
                onAuthSuccess(token, user);
                if (onClose) onClose();
            }, 500);
        } catch (err: any) {
            setErrorMsg(err.message || 'Network connection failed');
        } finally {
            setIsLoading(false);
        }
    };

    const handleRegisterSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrorMsg(null);
        setSuccessMsg(null);

        if (!regUsername.trim() || !regPassword) {
            setErrorMsg('Username and password are required');
            return;
        }

        if (regUsername.trim().length < 3) {
            setErrorMsg('Username must be at least 3 characters');
            return;
        }

        if (regPassword.length < 6) {
            setErrorMsg('Password must be at least 6 characters');
            return;
        }

        if (regPassword !== regConfirmPassword) {
            setErrorMsg('Passwords do not match');
            return;
        }

        setIsLoading(true);
        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: regUsername.trim(),
                    password: regPassword,
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                if (data.error === 'USERNAME_ALREADY_EXISTS') {
                    setErrorMsg('This username is already registered');
                } else {
                    setErrorMsg(data.error || 'Registration failed');
                }
                setIsLoading(false);
                return;
            }

            const token = data.token;
            const user = data.user || data.trader;
            setSuccessMsg(`Account created! Assigned ID: ${user.id}`);
            setTimeout(() => {
                onAuthSuccess(token, user);
                if (onClose) onClose();
            }, 600);
        } catch (err: any) {
            setErrorMsg(err.message || 'Network connection failed');
        } finally {
            setIsLoading(false);
        }
    };

    const containerClasses = isFullScreen
        ? "h-screen w-screen flex flex-col items-center justify-center bg-[#cfd3d8] relative overflow-hidden select-none font-mono"
        : "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 select-none font-mono";

    return (
        <div className={containerClasses}>
            {/* Background Atmosphere for Full Screen Portal */}
            {isFullScreen && (
                <div className="absolute inset-0 pointer-events-none opacity-40">
                    <div className="absolute inset-0 bg-[linear-gradient(to_right,#b4bcc840_1px,transparent_1px),linear-gradient(to_bottom,#b4bcc840_1px,transparent_1px)] bg-[size:32px_32px]" />
                </div>
            )}

            {/* Portal Header / Brand for Full Screen Mode */}
            {isFullScreen && (
                <div className="mb-6 text-center z-10">
                    <div className="flex items-center justify-center gap-2.5 mb-1.5">
                        <div className="p-2 bg-[#d4d8df] border border-[#b4bcc8] rounded-xl shadow-md">
                            <Activity size={24} className="text-blue-700 animate-pulse" />
                        </div>
                        <h1 className="text-2xl font-black tracking-widest text-slate-900 uppercase">
                            OPEN INTEREST
                        </h1>
                    </div>
                    <p className="text-xs text-slate-700 tracking-wider uppercase font-extrabold">
                        Institutional Multi-Venue Derivatives Trading Engine & Cockpit
                    </p>
                </div>
            )}

            <div className="bg-white border border-[#b4bcc8] rounded-xl w-full max-w-md shadow-2xl overflow-hidden z-10 animate-in fade-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="bg-[#d4d8df] border-b border-[#b4bcc8] px-5 py-3.5 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <Shield size={18} className={selectedRole === 'ADMIN' ? 'text-purple-700' : 'text-blue-700'} />
                        <div>
                            <div className="text-xs font-black tracking-wider text-slate-900 uppercase">
                                AUTHENTICATION GATEWAY
                            </div>
                            <div className="text-[10px] text-slate-600 font-semibold">
                                Role-Based Access Control (RBAC)
                            </div>
                        </div>
                    </div>
                    {!isFullScreen && onClose && (
                        <button
                            onClick={onClose}
                            className="text-slate-500 hover:text-slate-900 transition p-1 rounded hover:bg-slate-200"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {/* Tab Switcher */}
                <div className="grid grid-cols-2 border-b border-[#b4bcc8] bg-[#e2e6eb] text-xs font-bold">
                    <button
                        onClick={() => { setMode('LOGIN'); setErrorMsg(null); }}
                        className={`py-2.5 flex items-center justify-center gap-2 border-b-2 transition ${mode === 'LOGIN'
                            ? 'border-blue-700 text-blue-800 bg-white shadow-sm'
                            : 'border-transparent text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <LogIn size={14} />
                        <span>LOG IN</span>
                    </button>
                    <button
                        onClick={() => { setMode('REGISTER'); setErrorMsg(null); }}
                        className={`py-2.5 flex items-center justify-center gap-2 border-b-2 transition ${mode === 'REGISTER'
                            ? 'border-blue-700 text-blue-800 bg-white shadow-sm'
                            : 'border-transparent text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <UserPlus size={14} />
                        <span>REGISTER TRADER</span>
                    </button>
                </div>

                {/* Notification Alerts */}
                {errorMsg && (
                    <div className="m-4 mb-0 p-2.5 bg-red-100 border border-red-300 rounded flex items-center gap-2 text-red-900 text-xs font-semibold shadow-sm">
                        <AlertCircle size={15} className="shrink-0 text-red-700" />
                        <span>{errorMsg}</span>
                    </div>
                )}
                {successMsg && (
                    <div className="m-4 mb-0 p-2.5 bg-emerald-100 border border-emerald-300 rounded flex items-center gap-2 text-emerald-900 text-xs font-semibold shadow-sm">
                        <CheckCircle2 size={15} className="shrink-0 text-emerald-700" />
                        <span>{successMsg}</span>
                    </div>
                )}

                {/* Forms */}
                <div className="p-5">
                    {mode === 'LOGIN' ? (
                        <form onSubmit={handleLoginSubmit} className="space-y-4">
                            {/* Role Selection Radio Buttons */}
                            <div className="space-y-1.5">
                                <label className="block text-[10px] uppercase font-bold text-slate-600">
                                    Login as:
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <label
                                        onClick={() => setSelectedRole('TRADER')}
                                        className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition ${selectedRole === 'TRADER'
                                            ? 'bg-emerald-50 border-emerald-500 text-emerald-900 shadow-sm'
                                            : 'bg-slate-50 border-[#b4bcc8] text-slate-700 hover:bg-slate-100'
                                            }`}
                                    >
                                        <input
                                            type="radio"
                                            name="loginRole"
                                            value="TRADER"
                                            checked={selectedRole === 'TRADER'}
                                            onChange={() => setSelectedRole('TRADER')}
                                            className="accent-emerald-600 cursor-pointer"
                                        />
                                        <UserCheck size={14} />
                                        <span className="text-xs font-bold">Trader</span>
                                    </label>

                                    <label
                                        onClick={() => setSelectedRole('ADMIN')}
                                        className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition ${selectedRole === 'ADMIN'
                                            ? 'bg-purple-50 border-purple-500 text-purple-900 shadow-sm'
                                            : 'bg-slate-50 border-[#b4bcc8] text-slate-700 hover:bg-slate-100'
                                            }`}
                                    >
                                        <input
                                            type="radio"
                                            name="loginRole"
                                            value="ADMIN"
                                            checked={selectedRole === 'ADMIN'}
                                            onChange={() => setSelectedRole('ADMIN')}
                                            className="accent-purple-600 cursor-pointer"
                                        />
                                        <ShieldAlert size={14} />
                                        <span className="text-xs font-bold">Admin</span>
                                    </label>
                                </div>
                            </div>

                            <div>
                                <label className="block text-[10px] uppercase font-bold text-slate-600 mb-1">
                                    Username
                                </label>
                                <div className="relative">
                                    <User size={14} className="absolute left-3 top-2.5 text-slate-400" />
                                    <input
                                        type="text"
                                        value={loginUsername}
                                        onChange={(e) => setLoginUsername(e.target.value)}
                                        placeholder={selectedRole === 'ADMIN' ? "Admin username" : "Trader username"}
                                        className="w-full bg-slate-50 border border-[#b4bcc8] rounded pl-9 pr-3 py-2 text-xs font-bold text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 shadow-inner"
                                        required
                                        autoFocus
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-[10px] uppercase font-bold text-slate-600 mb-1">
                                    Password
                                </label>
                                <div className="relative">
                                    <Lock size={14} className="absolute left-3 top-2.5 text-slate-400" />
                                    <input
                                        type="password"
                                        value={loginPassword}
                                        onChange={(e) => setLoginPassword(e.target.value)}
                                        placeholder="••••••••"
                                        className="w-full bg-slate-50 border border-[#b4bcc8] rounded pl-9 pr-3 py-2 text-xs font-bold text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 shadow-inner"
                                        required
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={isLoading}
                                className={`w-full py-2.5 text-white text-xs font-black rounded shadow transition active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 ${selectedRole === 'ADMIN'
                                    ? 'bg-purple-700 hover:bg-purple-800'
                                    : 'bg-[#1d70b8] hover:bg-[#155b96]'
                                    }`}
                            >
                                <LogIn size={14} />
                                <span>{isLoading ? 'AUTHENTICATING...' : `SIGN IN AS ${selectedRole}`}</span>
                            </button>

                            <div className="pt-2 text-center text-[10px] text-slate-500 flex items-center justify-center gap-1.5 font-semibold">
                                <LockKeyhole size={11} />
                                <span>Zero-Trust Cryptographic Session Isolation</span>
                            </div>
                        </form>
                    ) : (
                        <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
                            <div>
                                <label className="block text-[10px] uppercase font-bold text-slate-600 mb-1">
                                    Desired Username
                                </label>
                                <div className="relative">
                                    <User size={14} className="absolute left-3 top-2.5 text-slate-400" />
                                    <input
                                        type="text"
                                        value={regUsername}
                                        onChange={(e) => setRegUsername(e.target.value)}
                                        placeholder="e.g. quant_desk_1"
                                        className="w-full bg-slate-50 border border-[#b4bcc8] rounded pl-9 pr-3 py-2 text-xs font-bold text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 shadow-inner"
                                        required
                                        autoFocus
                                    />
                                </div>
                                <span className="text-[9px] text-slate-500 mt-0.5 block">
                                    A unique trader account identity will be automatically assigned.
                                </span>
                            </div>

                            <div>
                                <label className="block text-[10px] uppercase font-bold text-slate-600 mb-1">
                                    Password (min 6 chars)
                                </label>
                                <div className="relative">
                                    <Lock size={14} className="absolute left-3 top-2.5 text-slate-400" />
                                    <input
                                        type="password"
                                        value={regPassword}
                                        onChange={(e) => setRegPassword(e.target.value)}
                                        placeholder="••••••••"
                                        className="w-full bg-slate-50 border border-[#b4bcc8] rounded pl-9 pr-3 py-2 text-xs font-bold text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 shadow-inner"
                                        required
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-[10px] uppercase font-bold text-slate-600 mb-1">
                                    Confirm Password
                                </label>
                                <div className="relative">
                                    <Lock size={14} className="absolute left-3 top-2.5 text-slate-400" />
                                    <input
                                        type="password"
                                        value={regConfirmPassword}
                                        onChange={(e) => setRegConfirmPassword(e.target.value)}
                                        placeholder="••••••••"
                                        className="w-full bg-slate-50 border border-[#b4bcc8] rounded pl-9 pr-3 py-2 text-xs font-bold text-slate-900 placeholder-slate-400 outline-none focus:border-blue-600 shadow-inner"
                                        required
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={isLoading}
                                className="w-full py-2.5 bg-[#1d70b8] hover:bg-[#155b96] text-white text-xs font-black rounded shadow transition active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                <UserPlus size={14} />
                                <span>{isLoading ? 'CREATING TRADER ACCOUNT...' : 'REGISTER TRADER ACCOUNT'}</span>
                            </button>

                            <div className="pt-2 text-center text-[10px] text-slate-500 flex items-center justify-center gap-1.5 font-semibold">
                                <Cpu size={11} />
                                <span>Default Zero-Risk Safe Onboarding Applied</span>
                            </div>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
};

