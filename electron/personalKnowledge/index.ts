// electron/personalKnowledge/index.ts
export {
    PersonalKnowledgeManager,
    type PersonalFileRecord,
    type PersonalFileSearchResult,
} from './PersonalKnowledgeManager';

export function getPersonalKnowledgeManager() {
    const { DatabaseManager } = require('../db/DatabaseManager');
    const db = DatabaseManager.getInstance().getDb();
    if (!db) throw new Error('Database is unavailable');
    const { PersonalKnowledgeManager } = require('./PersonalKnowledgeManager');
    return PersonalKnowledgeManager.getInstance(db);
}
