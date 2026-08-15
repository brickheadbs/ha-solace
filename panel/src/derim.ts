/**
 * Derim colour unit conversions and formatting.
 *
 * Definition:
 *   derim = 600 - mired
 *   mired = 600 - derim
 * where mired = 1,000,000 / kelvin.
 *
 * Properties:
 * - Linear with human colour perception (inheriting mired's spacing).
 * - Higher derim = cooler (higher Kelvin), lower derim = warmer (lower Kelvin).
 * - Practical range: 100 derim (2000 K candle/amber) to 433 derim (6000 K cool daylight).
 */

export const kelvinToMired = (kelvin: number): number => {
  if (kelvin <= 0) return 500;
  return 1_000_000 / kelvin;
};

export const miredToKelvin = (mired: number): number => {
  if (mired <= 0) return 6000;
  return Math.round(1_000_000 / mired);
};

export const miredToDerim = (mired: number): number => 600 - mired;

export const derimToMired = (derim: number): number => 600 - derim;

export const kelvinToDerim = (kelvin: number): number => {
  return Math.round((600 - kelvinToMired(kelvin)) * 10) / 10;
};

export const derimToKelvin = (derim: number): number => {
  const mired = derimToMired(derim);
  if (mired <= 0) return 6000;
  return Math.round(1_000_000 / mired);
};

export const formatDerim = (derim: number): string => `${Math.round(derim)} Ɯ`;

export const formatDerimWithKelvin = (derim: number): string => {
  const k = derimToKelvin(derim);
  return `${Math.round(derim)} Ɯ · ${k}K`;
};
