import React, { useRef, useState } from 'react';
import { Search, Coins } from 'lucide-react';
import api from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export default function LoyaltyPanel({ amount, onChange, initialPhone = '', disabled = false }) {
  const [phone, setPhone] = useState(initialPhone);
  const [account, setAccount] = useState(null);
  const [redeem, setRedeem] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const lookup = async (more = false) => {
    const request = ++sequence.current;
    setBusy(true);
    setError('');
    if (!more) { setAccount(null); setRedeem(0); onChange?.({ phone, redeem: 0, pending: true }); }
    try {
      const { data } = await api.get('/api/loyalty/customer', { params: { phone, offset: more ? account.history.length : 0 } });
      if (request !== sequence.current) return;
      setAccount({ ...data, history: more ? [...account.history, ...data.history] : data.history });
      if (!more) onChange?.({ phone: data.phone, redeem: 0 });
    } catch (failure) {
      if (request === sequence.current) setError(failure.response?.data?.detail || 'Could not load Dineflo Coins.');
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  };
  const limit = account?.can_redeem ? Math.max(0, Math.min(account.balance, Math.floor(amount || 0))) : 0;
  return <section className="space-y-3 min-w-0" aria-label="Dineflo Coins">
    <div className="flex items-center gap-2 font-semibold"><Coins className="h-5 w-5 text-emerald-700" />Dineflo Coins</div>
    <Label htmlFor="loyalty-phone">Customer mobile number</Label>
    <div className="flex gap-2">
      <Input id="loyalty-phone" type="tel" inputMode="tel" autoComplete="off" value={phone} placeholder="10-digit mobile number" disabled={disabled} onChange={(event) => {
        sequence.current += 1; setBusy(false); setPhone(event.target.value); setAccount(null); setError(''); setRedeem(0);
        onChange?.(event.target.value.trim() ? { phone: event.target.value, redeem: 0, pending: true } : null);
      }} />
      <Button type="button" variant="outline" disabled={busy || disabled || !phone.trim()} onClick={() => lookup()} aria-label="Check coin balance" title="Check coin balance"><Search className="h-4 w-4" /></Button>
    </div>
    {busy && <p className="text-sm" role="status">Loading balance...</p>}
    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    {account && <>
      <div className="flex flex-wrap justify-between gap-2 border-y py-3"><span className="font-semibold">{account.balance} coins</span><span className="text-sm text-muted-foreground">{account.can_redeem ? 'Available to redeem' : `${200 - account.balance} coins to unlock redemption`}</span></div>
      {onChange && <div className="space-y-2">
        <Label htmlFor="loyalty-redeem">Coins to redeem (maximum {limit})</Label>
        <Input id="loyalty-redeem" type="number" min="0" max={limit} step="1" disabled={disabled || !limit} value={redeem} onChange={(event) => {
          const value = Math.max(0, Math.min(limit, Math.floor(Number(event.target.value) || 0)));
          setRedeem(value); onChange({ phone: account.phone, redeem: value });
        }} />
        <p className="text-sm text-emerald-700">{Math.floor(Math.max(0, (amount || 0) - redeem) / 100) * 8} coins earned on this payment</p>
      </div>}
      <details className="border-t pt-2">
        <summary className="cursor-pointer text-sm font-semibold">Coin and redemption history ({account.total_entries})</summary>
        <div className="max-h-48 overflow-auto divide-y mt-2">
          {account.history.map((entry) => <div key={`${entry.payment_id}-${entry.kind}`} className="py-2 text-sm">
            <div className="flex flex-wrap justify-between gap-1"><span className="break-all">{entry.bill_id}</span><span>{entry.kind === 'reversal' ? 'Bill reversed' : `Earned ${entry.earned} / Redeemed ${entry.redeemed}`}</span></div>
            <div className="text-xs text-muted-foreground">{new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(entry.created_at) ? entry.created_at : `${entry.created_at}Z`).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · Balance {entry.balance}</div>
            {entry.reason && <p className="break-words">{entry.reason}</p>}
          </div>)}
          {!account.history.length && <p className="py-3 text-sm text-muted-foreground">No coin activity yet.</p>}
        </div>
        {account.history.length < account.total_entries && <Button variant="ghost" type="button" disabled={busy} onClick={() => lookup(true)}>Load more</Button>}
      </details>
    </>}
  </section>;
}
