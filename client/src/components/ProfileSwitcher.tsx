import { Check, ChevronDown, Pencil, Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { Profile } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useApp } from '../context.ts';
import { Dialog } from './ui.tsx';

export function ProfileSwitcher() {
  const { state, switchProfile, changed } = useApp();
  const current = state.profiles.find((p) => p.id === state.profileId)!;
  const [mode, setMode] = useState<'list' | 'new' | Profile | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edit = (profile?: Profile) => { setName(profile?.name ?? ''); setError(''); setMode(profile ?? 'new'); };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const creating = mode === 'new';
      const profile = await api<Profile>(creating ? '/profiles' : `/profiles/${(mode as Profile).id}`, {
        method: creating ? 'POST' : 'PUT', body: { name }, profileId: state.profileId,
      });
      setMode(null);
      if (creating) switchProfile(profile.id);
      else changed('Nombre guardado');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button className="profile-switch" aria-label={`Cuenta: ${current.name}. Cambiar cuenta`} aria-haspopup="dialog" onClick={() => setMode('list')}>
        <span className="profile-avatar"><UserRound size={16} /></span><span className="profile-name">{current.name}</span><ChevronDown size={14} />
      </button>
      {mode && <Dialog title={mode === 'list' ? 'Cuentas' : mode === 'new' ? 'Nueva cuenta' : 'Cambiar nombre'} onClose={() => { if (!busy) setMode(null); }}>
        {mode === 'list' ? <>
          <div className="profile-list">
            {state.profiles.map((p) => <div className="profile-row" key={p.id}>
              <button className={`profile-option ${p.id === current.id ? 'on' : ''}`} onClick={() => { setMode(null); if (p.id !== current.id) switchProfile(p.id); }}>
                <span className="profile-avatar">{p.name.charAt(0).toUpperCase()}</span><span className="profile-name">{p.name}</span>{p.id === current.id && <Check size={17} />}
              </button>
              <button className="btn quiet icon" aria-label={`Cambiar nombre de ${p.name}`} onClick={() => edit(p)}><Pencil size={15} /></button>
            </div>)}
          </div>
          <button className="btn profile-new" onClick={() => edit()}><Plus size={16} /> Nueva cuenta</button>
        </> : <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {mode === 'new' && <p className="small muted">Un FIFO independiente para cada persona.</p>}
          <label className="field"><span>Nombre</span><input key={typeof mode === 'string' ? mode : mode.id} autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. María" maxLength={60} required disabled={busy} /></label>
          {error && <p className="small loss" role="alert">{error}</p>}
          <div className="dialog-actions"><button type="button" className="btn quiet" disabled={busy} onClick={() => setMode('list')}>Volver</button><button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Guardando…' : mode === 'new' ? 'Crear cuenta' : 'Guardar'}</button></div>
        </form>}
      </Dialog>}
    </>
  );
}
