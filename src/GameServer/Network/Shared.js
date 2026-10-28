const ClassProgression = invoke('GameServer/ClassProgression');
const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');
const BackpackModel  = invoke('GameServer/Model/Backpack');

const Shared = {
    fetchClassInformation: (classId) => {
        return new Promise((success, fail) => {
            let model = ClassProgression.firstClassRow(DataCache.classTemplates, classId, 'strict');
            return model ? success(model) : fail();
        });
    },

    fetchCharacters(accountId) {
        // Every read failure rejects the returned Promise, so the caller's
        // catch (or the packet dispatch boundary) sees it.
        const createPaperdoll = (character) => {
            return Promise.all([
                Database.fetchItems(character.id, 'character_list'),
                Database.fetchCharacterRecipes(character.id)
            ]).then(([items, recipes]) => {
                character.items = items;
                character.dwarvenRecipes = recipes.filter((recipe) => recipe.type === 'dwarven');
                character.commonRecipes = recipes.filter((recipe) => recipe.type === 'common');
                const projection = BackpackModel.projectEquipment(items);
                character.paperdoll = projection.paperdoll;
                const repaired = [...projection.repaired];
                repaired.forEach(item => { item.equipped = 0; });
                Promise.all(repaired.map((item) => Database.updateItemEquipState(character.id, item.id, false, item.slot)))
                    .catch((error) => utils.infoWarn('Character', 'failed to repair equipment state for %s: %s', character.name, error.message));
            });
        };

        // The read starts synchronously, as before; a synchronous throw from
        // it rejects instead of escaping to the caller.
        return new Promise((resolve) => resolve(Database.fetchCharacters(accountId))).then((characters) => {
            return characters.reduce((previous, character) => {
                return previous.then(() => {
                    return createPaperdoll(character);
                });
            }, Promise.resolve()).then(() => characters);
        });
    },

    enterCharacterHall(session, characters) {
        invoke('GameServer/World/World').retireUserActor(session, session.actor);
        session.dataSendToMe(
            ServerResponse.charSelectInfo(characters)
        );
    }
};

module.exports = Shared;
