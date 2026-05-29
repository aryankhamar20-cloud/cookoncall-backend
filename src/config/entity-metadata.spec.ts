/**
 * TypeORM entity-metadata smoke test
 *
 * Locks in the contract that broke production in PR #26 → hotfix #29:
 *   "Every @Entity in src/modules/** must declare a column type that
 *    the postgres driver understands at DataSource.buildMetadatas()."
 *
 * Background — what this guards against
 * --------------------------------------
 * In PR #26 we flipped strictNullChecks on, and to satisfy the compiler
 * a few entity columns were rewritten from
 *
 *     @Column({ type: 'varchar', length: 15, nullable: true })
 *     phone: string;
 *
 * to
 *
 *     @Column({ nullable: true })
 *     phone: string | null;
 *
 * That looked harmless in TS but at runtime TypeORM's metadata builder
 * tried to infer the postgres column type from the union `string | null`
 * via reflect-metadata, got back the literal `Object`, and refused to
 * build the schema:
 *
 *     DataTypeNotSupportedError: Data type "Object" in "User.phone"
 *     is not supported by "postgres" database.
 *         at EntityMetadataValidator.validate ...
 *         at DataSource.buildMetadatas ...
 *         at async DataSource.initialize ...
 *
 * Production crash-looped on Railway through 5 retry cycles before the
 * container was killed. Hotfix #29 restored explicit `type: 'varchar'`
 * on the affected columns.
 *
 * What this test does
 * -------------------
 * 1. Discovers every *.entity.ts under src/modules at test time.
 *    Any new entity dropped into the tree is automatically covered —
 *    zero maintenance.
 * 2. Forces each file to load. The @Entity decorator side-effect
 *    registers the class with TypeORM's global metadata storage.
 * 3. Constructs a postgres DataSource pointing at a dummy host
 *    (no network I/O happens — buildMetadatas runs purely in-process,
 *    before any connection is opened).
 * 4. Invokes the same buildMetadatas() that production runs inside
 *    DataSource.initialize(). If any column has an unmappable type,
 *    this throws with the exact entity + field name in the message,
 *    same as the prod stack trace — the failing reviewer sees the
 *    problem in their CI log without needing to redeploy to discover it.
 *
 * Cost: ~half a second on a cold Jest run. Catches the entire class
 * of "ts-only fix that breaks postgres reflection" bugs before merge.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, getMetadataArgsStorage } from 'typeorm';

/** Recursively find every *.entity.ts under `dir`. */
function findEntityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findEntityFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('TypeORM entity metadata (startup smoke test)', () => {
  it('builds successfully for every @Entity registered under src/modules', async () => {
    // 1. Discover entity files at the source-tree level.
    const modulesDir = path.resolve(__dirname, '..', 'modules');
    const files = findEntityFiles(modulesDir);

    // Sanity check — the project should have entities. If this drops to
    // zero we've either moved the modules dir or the glob is wrong, both
    // of which would silently disable the protection. Fail loudly instead.
    expect(files.length).toBeGreaterThan(0);

    // 2. Force-load each file so the @Entity side-effect fires.
    for (const f of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(f);
    }

    // 3. Pull the canonical entity list from TypeORM's global storage.
    //    This is the same set TypeOrmModule.forFeature/forRoot registers
    //    in production via autoLoadEntities.
    const entities = getMetadataArgsStorage()
      .tables.map((t) => t.target)
      .filter((t): t is Function => typeof t === 'function');

    expect(entities.length).toBeGreaterThan(0);

    // 4. Build a postgres DataSource and run buildMetadatas(). Dummy
    //    connection params — buildMetadatas is pure in-memory work,
    //    it does not open a socket.
    const ds = new DataSource({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'noop',
      password: 'noop',
      database: 'noop',
      entities,
    });

    // buildMetadatas() is the exact function that threw in prod
    // (Railway log: "at DataSource.buildMetadatas ..."). If a column
    // has no resolvable postgres type the underlying
    // EntityMetadataValidator throws DataTypeNotSupportedError with
    // a message naming the entity + field — let it surface untouched
    // so a failing developer sees the same diagnosis we'd see in prod
    // logs, just before merge instead of after.
    //
    // Cast to any: buildMetadatas is internal in the public typings
    // but stable in TypeORM 0.3.x and is the documented call point
    // in the prod stack trace we're guarding against.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ds as any).buildMetadatas();
  });
});
