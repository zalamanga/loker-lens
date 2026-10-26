export class Problem extends Error {
  constructor(code, message, status = 422, options) {
    super(message, options);
    this.name = 'Problem';
    this.code = code;
    this.status = status;
  }
}

export function publicFailure(error) {
  return error instanceof Problem
    ? { status: error.status, body: { error: error.message, code: error.code } }
    : { status: 503, body: { error: 'Data belum dapat diperiksa. Hasil terakhir tetap dipertahankan.', code: 'unavailable' } };
}
