import { useEffect, useRef, useState } from "react";
import { acquirePaymentSession } from "./paymentSession.js";

export function usePaymentSession(onAcquire) {
  const [state, setState] = useState("acquiring");
  const session = useRef(null);
  const acquireRef = useRef(onAcquire);
  acquireRef.current = onAcquire;
  useEffect(() => {
    const lease = acquirePaymentSession({ onState: setState, onAcquire: () => acquireRef.current?.() });
    session.current = lease;
    return () => lease.close();
  }, []);
  return {
    state,
    isOwner: () => session.current?.isOwner() === true,
    beginOperation: () => session.current?.beginOperation() ?? null,
  };
}
