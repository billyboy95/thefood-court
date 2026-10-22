import { createDemoStore } from '../demo/store.js';

/**
 * On-device demo of every feature. Used when SUPABASE_URL and SUPABASE_ANON_KEY
 * are empty. Nothing here is shared with another phone.
 */
function wrap(fn) {
  return async (...args) => fn(...args);
}

export function createMockOrderApi(storage, options = {}) {
  const store = createDemoStore(storage, options);
  return {
    mode: 'mock',
    getMenu: wrap(() => store.getMenu()),
    getBoard: wrap(() => store.getBoard()),
    getPickupSlots: wrap((now) => store.getPickupSlots(now)),
    createOrder: wrap((input) => store.createOrder(input)),
    getOrder: wrap((id) => store.getOrder(id)),
    verifyStaffPin: wrap((pin) => store.verifyStaffPin(pin)),
    listOpenOrders: wrap((pin) => store.listOpenOrders(pin)),
    updateOrderStatus: wrap((id, status, pin) => store.updateOrderStatus(id, status, pin)),
    cancelOrder: wrap((id, pin) => store.cancelOrder(id, pin)),
    setSoldOut: wrap((itemId, soldOut, pin) => store.setSoldOut(itemId, soldOut, pin)),
    setPortions: wrap((itemId, portions, pin) => store.setPortions(itemId, portions, pin)),
    currentStudent: wrap(() => store.currentStudent()),
    signInStudent: wrap((input) => store.signInStudent(input)),
    registerStudent: wrap((input) => store.registerStudent(input)),
    requestEmailCode: wrap((input) => store.requestEmailCode(input)),
    verifyEmailCode: wrap((input) => store.verifyEmailCode(input)),
    signOutStudent: wrap(() => store.signOutStudent()),
    getWallet: wrap(() => store.getWallet()),
    rotatePayToken: wrap(() => store.rotatePayToken()),
    topUp: wrap((input) => store.topUp(input)),
    setAutoTopup: wrap((input) => store.setAutoTopup(input)),
    linkNfc: wrap((input) => store.linkNfc(input)),
    tillCharge: wrap((input) => store.tillCharge(input)),
    verifyChefPin: wrap((pin) => store.verifyChefPin(pin)),
    publishSpecial: wrap((input) => store.publishSpecial(input)),
    getSpecials: wrap(() => store.getSpecials()),
    listReady: wrap(() => store.listReady()),
    getReport: wrap((input) => store.getReport(input)),
    getStock: wrap((pin) => store.getStock(pin)),
    receiveGoods: wrap((input) => store.receiveGoods(input)),
    logWaste: wrap((input) => store.logWaste(input)),
    saveStockTake: wrap((input) => store.saveStockTake(input)),
    getSettings: wrap((pin) => store.getSettings(pin)),
    saveSettings: wrap((pin, patch) => store.saveSettings(pin, patch)),
    runAutomations: wrap((pin, job) => store.runAutomations(pin, job)),
    rateOrder: wrap((input) => store.rateOrder(input)),
    getForecast: wrap((pin) => store.getForecast(pin)),
  };
}
