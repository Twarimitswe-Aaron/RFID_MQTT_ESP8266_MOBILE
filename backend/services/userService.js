const sqliteDB = require('../config/sqlite_database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

class UserService {
  static async createUser(username, password, role = 'user') {
    const hashed = await bcrypt.hash(password, 10);
    return sqliteDB.createUser(username, hashed, role);
  }

  static async authenticateUser(username, password) {
    const user = sqliteDB.getUser(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new Error('Invalid credentials');
    }
    return user;
  }

  static generateToken(user) {
    const secret = process.env.JWT_SECRET || 'secret123';
    // Use user.id (SQLite rowid) for the token payload
    return jwt.sign({ id: user.id, username: user.username, role: user.role }, secret, { expiresIn: '24h' });
  }
}

module.exports = UserService;
