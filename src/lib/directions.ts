// Google Maps directions link for a clinic. Uses the documented Maps URLs API
// (https://developers.google.com/maps/documentation/urls/get-started), which opens the Google Maps
// app on phones and the website on desktop. The address is the destination when we have one (the
// NS1 list's coordinates date from 2016 and are less reliable than the address); otherwise lat,lng.
export function directionsUrl(address: string | null | undefined, lng: number, lat: number): string | null {
  const addr = (address ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  let dest: string;
  if (addr) dest = addr;
  else if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) dest = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  else return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
