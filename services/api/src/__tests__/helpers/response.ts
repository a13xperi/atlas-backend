export function expectSuccessResponse<T = any>(body: any): T {
  expect(body.ok).toBe(true);
  expect(body.timestamp).toEqual(expect.any(String));
  return body.data as T;
}

export function expectErrorResponse(body: any, message?: string): any {
  expect(body.ok).toBe(false);
  expect(body.timestamp).toEqual(expect.any(String));
  if (message !== undefined) {
    expect(body.error).toBe(message);
  }
  return body;
}
