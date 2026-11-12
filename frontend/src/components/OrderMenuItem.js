import React, { useState } from 'react';
import { Plus, Utensils } from 'lucide-react';
import { normalizeImageUrl } from '../lib/utils';
import DietIndicator from './DietIndicator';
import { Button } from './ui/button';

export default function OrderMenuItem({ item, quantity = 0, onAdd, disabled = false }) {
  const [broken, setBroken] = useState(false);
  const image = normalizeImageUrl(item.image);
  const unavailable = disabled || !item.available;
  return (
    <article className={`flex min-w-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white ${!item.available ? 'opacity-60' : ''}`}>
      <button type="button" aria-label={`Add ${item.name}`} disabled={unavailable} onClick={() => onAdd(item)} className="text-left">
        {image && !broken ? <img src={image} alt={item.name} onError={() => setBroken(true)} className="h-24 w-full object-cover" />
          : <div className="flex h-24 items-center justify-center bg-gray-100 text-gray-400"><Utensils className="h-6 w-6" /></div>}
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start gap-2"><DietIndicator item={item} className="mt-1" /><h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{item.name}</h3>
          {quantity > 0 && <span className="text-sm font-semibold text-emerald-700">{quantity}</span>}</div>
        <p className="text-base font-semibold text-primary">₹{Number(item.price || 0).toFixed(2)}</p>
        <Button type="button" className="mt-auto h-11 w-full rounded-lg" aria-label={`Add one ${item.name}`} disabled={unavailable} onClick={() => onAdd(item)}><Plus className="mr-1 h-4 w-4" />{item.available ? 'Add' : 'Unavailable'}</Button>
      </div>
    </article>
  );
}
