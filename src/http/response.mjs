export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra
    }
  });
}
export function cookie(value, admin = false, seconds = 0) {
  return `${admin ? 'qs_admin' : 'qs_session'}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
}
export function getCookie(request, name) {
  return (
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + '='))
      ?.slice(name.length + 1) || ''
  );
}
