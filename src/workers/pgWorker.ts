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
    // relaxedDurability: return each query's result as soon as Postgres has
    // it, and write the database to IndexedDB in the background. Without it
    // every query (reads too) waited for a full IndexedDB flush, ~400 ms
    // each, so saving one claim edit (about a dozen queries) took 5-9 s.
    // The flush still happens after every query; only the wait is gone.
    return new PGlite('idb://claimsense-pg', { relaxedDurability: true })
  },
})
