import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRouter } from '../js/lib/router.js';

describe('router', () => {
  it('maps kitchen and order paths', () => {
    const router = createRouter({ render() {}, windowObj: { location: { pathname: '/' } } });
    assert.equal(router.pathFrom('/').name, 'menu');
    assert.equal(router.pathFrom('/kitchen').name, 'kitchen');
    assert.equal(router.pathFrom('/kitchen.html').name, 'kitchen');
    assert.equal(router.pathFrom('/kitchen/reports').name, 'reports');
    assert.equal(router.pathFrom('/kitchen/stock').name, 'stock');
    assert.equal(router.pathFrom('/kitchen/settings').name, 'settings');
    assert.equal(router.pathFrom('/wallet').name, 'wallet');
    assert.equal(router.pathFrom('/specials').name, 'specials');
    assert.equal(router.pathFrom('/chef').name, 'chef');
    assert.equal(router.pathFrom('/counter').name, 'counter');
    assert.equal(router.pathFrom('/order/abc').id, 'abc');
    assert.equal(router.pathFrom('/nope').name, 'notfound');
  });
});
