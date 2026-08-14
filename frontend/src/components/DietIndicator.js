import React from 'react';

export const DIET_TYPES = {
  veg: {
    label: 'Veg',
    borderClass: 'border-green-600',
    dotClass: 'bg-green-600',
    activeClass: 'border-green-200 bg-green-50 text-green-700',
  },
  non_veg: {
    label: 'Non-Veg',
    borderClass: 'border-red-600',
    dotClass: 'bg-red-600',
    activeClass: 'border-red-200 bg-red-50 text-red-700',
  },
  egg: {
    label: 'Egg',
    borderClass: 'border-yellow-500',
    dotClass: 'bg-yellow-500',
    activeClass: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  },
  vegan: {
    label: 'Vegan',
    borderClass: 'border-emerald-600',
    dotClass: 'bg-emerald-600',
    activeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
};

const DietIndicator = ({ item, className = '' }) => {
  const config = DIET_TYPES[item?.diet_type] || DIET_TYPES.veg;

  return (
    <span
      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${config.borderClass} ${className}`}
      aria-label={config.label}
      title={config.label}
    >
      <span className={`h-2 w-2 rounded-full ${config.dotClass}`} />
    </span>
  );
};

export default DietIndicator;
