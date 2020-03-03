const assert = require("assert").strict;
const helper = require("../helper");
const testing = require("taskcluster-lib-testing");
const { UNIQUE_VIOLATION } = require("taskcluster-lib-postgres");
const _ = require("lodash");
const fs = require("fs");
const yaml = require("js-yaml");
const path = require("path");

const content = yaml.safeLoad(fs.readFileSync(path.join(__dirname, "..", "..", "access.yml")));
const services = Object.entries(content);

suite("services checks", function() {
  test("has all services", function() {
    assert.deepEqual(
      Object.keys(content).sort(),
      [
        "auth",
        "github",
        "hooks",
        "index",
        "notify",
        "purge_cache",
        "queue",
        "secrets",
        "web_server",
        "worker_manager"
      ]
    );
  });
});

for (let service of services) {
  const [serviceName, { tables }] = service;
  const tableNames = Object.keys(tables).filter(name => name.endsWith("_entities"));

  for (let tableName of tableNames) {
    const clients = [
      { first: "foo", last: "bar" },
      { first: "bar", last: "foo" },
      { first: "baz", last: "gamma" }
    ];

    suite(`${testing.suiteName()} - ${serviceName}`, function() {
      helper.withDbForProcs({ serviceName });
      setup(`reset ${tableName} table`, async function() {
        await helper.withDbClient(async client => {
          await client.query(`delete from ${tableName}`);
          await client.query(`insert into ${tableName} (partition_key, row_key, value, version) values ('foo', 'bar', '{ "first": "foo", "last": "bar" }', 1), ('bar', 'foo', '{ "first": "bar", "last": "foo" }', 1)`);
        });
        const sn = serviceName === 'index' ? `fake${serviceName}` : serviceName;
        await helper.fakeDb[sn].reset();
        await helper.fakeDb[sn][`${tableName}_create`]("foo", "bar", clients[0], false, 1);
        await helper.fakeDb[sn][`${tableName}_create`]("bar", "foo", clients[1], false, 1);
      });

      helper.dbTest(`${tableName}_load`, async function(db, isFake) {
        const [fooClient] = await db.fns[`${tableName}_load`]("foo", "bar");
        assert(typeof fooClient.etag === "string");
        assert.equal(fooClient.partition_key_out, "foo");
        assert.equal(fooClient.row_key_out, "bar");
        assert.equal(fooClient.version, 1);
        assert.deepEqual(clients[0], fooClient.value);
      });

      helper.dbTest(`${tableName}_create`, async function(db, isFake) {
        const [{ [`${tableName}_create`]: etag }] = await db.fns[`${tableName}_create`]('baz', 'gamma', clients[2], false, 1);
        assert(typeof etag === 'string');
        const [bazClient] = await db.fns[`${tableName}_load`]('baz', 'gamma');
        assert.equal(bazClient.etag, etag);
        assert.equal(bazClient.partition_key_out, 'baz');
        assert.equal(bazClient.row_key_out, 'gamma');
        assert.equal(bazClient.version, 1);
        assert.deepEqual(clients[2], bazClient.value);
      });

      helper.dbTest(`${tableName}_create throws when overwrite is false`, async function(db, isFake) {
        await db.fns[`${tableName}_create`]('baz', 'gamma', clients[2], false, 1);
        await assert.rejects(
          () => db.fns[`${tableName}_create`]('baz', 'gamma', clients[2], false, 1),
          err => err.code === UNIQUE_VIOLATION,
        );
      });

      helper.dbTest(`${tableName}_create does not throw when overwrite is true`, async function(db, isFake) {
        await db.fns[`${tableName}_create`]('baz', 'gamma', clients[2], true, 1);
        await db.fns[`${tableName}_create`]('baz', 'gamma', { ...clients[2], last: 'updated' }, true, 1);

        const [bazClient] = await db.fns[`${tableName}_load`]('baz', 'gamma');
        assert.deepEqual({ ...clients[2], last: 'updated' }, bazClient.value);
      });

      helper.dbTest(`${tableName}_remove`, async function(db, isFake) {
        const [fooClient] = await db.fns[`${tableName}_remove`]('foo', 'bar');
        const c = await db.fns[`${tableName}_load`]('foo', 'bar');
        assert(typeof fooClient.etag === 'string');
        assert.equal(c.length, 0);
      });

      helper.dbTest(`${tableName}_modify`, async function(db, isFake) {
        const value = { first: 'updated', last: 'updated' };
        const [{ etag: oldEtag }] = await db.fns[`${tableName}_load`]('foo', 'bar');
        const [etag] = await db.fns[`${tableName}_modify`]('foo', 'bar', value, 1, oldEtag);
        const [fooClient] = await db.fns[`${tableName}_load`]('foo', 'bar');
        assert(fooClient.etag !== etag);
        assert.equal(fooClient.partition_key_out, 'foo');
        assert.equal(fooClient.row_key_out, 'bar');
        assert.equal(fooClient.version, 1);
        assert.equal(fooClient.value.first, 'updated');
        assert.equal(fooClient.value.last, 'updated');
      });

      helper.dbTest(`${tableName}_modify throws when no such row`, async function(db, isFake) {
        const value = { first: 'updated', last: 'updated' };
        const [{ etag: oldEtag }] = await db.fns[`${tableName}_load`]('foo', 'bar');
        await assert.rejects(
          async () => {
            await db.fns[`${tableName}_modify`]('foo', 'does-not-exist', value, 1, oldEtag);
          },
          err => err.code === 'P0002',
        );
      });

      helper.dbTest(`${tableName}_modify throws when update was unsuccessful (e.g., etag value did not match)`, async function(db, isFake) {
        const value = { first: 'updated', last: 'updated' };
        const [{ etag: oldEtag }] = await db.fns[`${tableName}_load`]('foo', 'bar');
        await db.fns[`${tableName}_modify`]('foo', 'bar', value, 1, oldEtag);
        await assert.rejects(
          async () => {
            await db.fns[`${tableName}_modify`]('foo', 'bar', value, 1, oldEtag);
          },
          err => err.code === 'P0004',
        );
      });
    });
  }
}