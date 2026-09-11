export function lastRes<DataType>(
  data: DataType,
  msg?: string,
  success: boolean = false
) {
  msg = !msg ? (success ? "successful" : "failed") : msg;

  const obj = {
    failed: !success,
    ok: success,
    data,
    msg,
  };
  return {
    ...obj,
  };
}
export function sendRes<T>(data: ReturnType<typeof lastRes<T>>) {
  const { ok, msg, data: d } = data;
  return {
    status: ok ? "ok" : "nok",
    msg,
    data: d,
  };
}
export type SendResType<T> = ReturnType<typeof sendRes<T>>;

export type LastResType<T> = ReturnType<typeof lastRes<T>>;

export function addTimeFromNow(addNumber: number) {
  return Date.now() + addNumber * 1000;
}
