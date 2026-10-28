function fetchItem(id) {
    return new Promise((success, fail) => {
        let item = require('../GroundItemIndex').find(this, id);
        return item ? success(item) : fail();
    });
}

module.exports = fetchItem;
