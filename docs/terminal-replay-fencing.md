# Terminal replay ownership

All SDK verifier and facilitator terminal writes present the token returned by
their reservation. A delayed verifier whose slot was reclaimed cannot mark the
successor consumed or rejected. Existing terminal states remain write-once.

The optional token on the lower-level terminal helpers preserves trusted
operator reconciliation calls. Application settlement code must always supply
its reservation token. This change does not alter valid inflight TTL recovery
or replace durable, shared, atomic replay storage.
