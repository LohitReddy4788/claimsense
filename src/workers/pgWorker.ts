import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'

// Hosts the app's one PostgreSQL instance. PGlite keeps the database in
// memory and flushes it to IndexedDB, so two instances on the same data
// (two open tabs) would silently overwrite each other's writes. With this
// worker, the tabs elect a single leader that owns the database; every
// other tab's queries are forwarded to it, and if the leader tab closes,
// another takes over.
worker({
  async init() {
    return new PGlite('idb://claimsense-pg')
  },
})
