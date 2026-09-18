import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRouter } from '../js/lib/router.js';

describe('router', () => {
  it('maps kitchen and order paths', () => {
    const router = createRouter({ render() {}, windowObj: { location: { pathname: '/' } } });
    assert.equal(router.pathFrom('/').name, 'menu');
    assert.equal(router.pathFrom('/kitchen').name, 'kitchen');
    assert.equal(router.pathFrom('/kitchen.html').name, 'kitchen');
    assert.equal(router.pathFrom('/order/abc').id, 'abc');
    assert.equal(router.pathFrom('/nope').name, 'notfound');
  });
});
