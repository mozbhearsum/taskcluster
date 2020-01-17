const helper = require('./helper');
const { Schema } = require('taskcluster-lib-postgres');
const { Entity } = require('taskcluster-lib-entities');
const path = require('path');
const assert = require('assert').strict;

helper.dbSuite(path.basename(__filename), function() {
  let db;

  teardown(async function() {
    if (db) {
      try {
        await db.close();
      } finally {
        db = null;
      }
    }
  });

  const schema = Schema.fromDbDirectory(path.join(__dirname, 'db'));
  const properties = {
    taskId: Entity.types.String,
    provisionerId: Entity.types.String,
    workerType: Entity.types.String,
  };
  const entity = Entity.configure({
    partitionKey: 'taskId',
    rowKey: 'provisionerId',
    properties,
  });
  const serviceName = 'test-entities';

  suite('entity create', function() {
    test('create entry', async function() {
      db = await helper.withDb({ schema, serviceName });
      const taskId = '123';
      const provisionerId = '456';
      const entry = {
        taskId,
        provisionerId,
        workerType: '567',
      };

      entity.setup({ tableName: 'test_entities', db, serviceName });
      await entity.create(entry);

      const result = await entity.load({ taskId, provisionerId });

      assert.equal(result.taskId, taskId);
      assert.equal(result.provisionerId, provisionerId);
      assert.deepEqual(result.properties, entry);
      assert(result.etag);
    });

    test('create entry (overwriteIfExists)', async function() {
      db = await helper.withDb({ schema, serviceName });
      const taskId = '123';
      const provisionerId = '456';
      let entry = {
        taskId,
        provisionerId,
        workerType: '567',
      };

      entity.setup({ tableName: 'test_entities', db, serviceName });
      await entity.create(entry);

      const old = await entity.load({ taskId, provisionerId });
      entry = {
        ...entry,
        workerType: 'foo',
      };

      await entity.create(entry, true);

      const result = await entity.load({ taskId, provisionerId });

      assert.equal(old.workerType, '567');
      assert.equal(result.workerType, 'foo');
      assert.notEqual(old.etag, result.etag);
    });

    test('create entry (overwriteIfExists, doesn\'t exist)', async function() {
      db = await helper.withDb({ schema, serviceName });
      const taskId = '123';
      const provisionerId = '456';
      let entry = {
        taskId,
        provisionerId,
        workerType: '567',
      };

      entity.setup({ tableName: 'test_entities', db, serviceName });
      await entity.create(entry, true);

      const result = await entity.load({ taskId, provisionerId });

      assert.equal(result.workerType, '567');
    });

    test('create entry (won\'t overwrite)', async function () {
      db = await helper.withDb({ schema, serviceName });
      const taskId = '123';
      const provisionerId = '456';
      let entry = {
        taskId,
        provisionerId,
        workerType: '567',
      };

      entity.setup({ tableName: 'test_entities', db, serviceName });
      await entity.create(entry);
      await entity.load({ taskId, provisionerId });

      entry = {
        ...entry,
        workerType: 'foo',
      };

      await assert.rejects(
        async () => {
          await entity.create(entry, false);
        },
        // already exists
        err => {
          assert.equal(err.code, 'EntityAlreadyExists');

          return true;
        },
      );
    });
  });
});