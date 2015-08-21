import {model, index, pre, post} from 'mongoose-decorators';
import co from 'co';
import Bcrypt from "../utils/Bcrypt"
import {AuthenticationError} from "../utils/errors"
import {Validations} from "../utils/ValidationHelper"
import {CONFIG, config} from '../utils/globals';

/**
 * 1. store only hashed passwords
 * 2. A user's account should be "locked" after some number of consecutive failed login attempts.
 * 3. A user's account should become unlocked once a sufficient amount of time has passed
 * 4. The User model should expose the reason for a failed login attempt to the application
 */

const SALT_WORK_FACTOR = config('bcrypt').saltWorkFactor || 10
      , MAX_LOGIN_ATTEMPTS = config('login').maxLoginAttempts || 5
      , LOCK_TIME = config('login').lockTime || 2 * 60 * 60 * 1000;

const failedLogin = {
  NOT_FOUND: 0,
  PASSWORD_INCORRECT: 1,
  MAX_ATTEMPTS: 2
};

//noinspection ES6Validation
@model(
  {
    username: {type: String, required: Validations.general.required, unique: true, lowercase: true},
    password: {
      type: String,
      validate: Validations.password.pattern
    },
    provider: {
      type: String,
      required:true,
      enum: {values: ['local', 'google', 'facebook']}
    },
    email: {
      type: String,
      unique: true,
      required: Validations.email.required,
      validate: Validations.email.pattern
    },
    name: {type: String},
    role: {
      type: String,
      enum: {values: ['admin', 'user'], default: 'user', message: Validations.role.invalid}
    },
    enabled: {type: Boolean, default: false},
    accountExpired: Boolean,
    passwordExpired: Boolean,

    loginAttempts: { type: Number, required: true, default: 0 },
    lockUntil: { type: Number }
  },
  {
    toJSON: {
      transform: function (doc, ret, options) {
        delete ret.password;
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v
      }
    }
  }
)
export default class User {

  //noinspection ES6Validation
  @pre('save')
  hashPassword(next) {
    var self = this;
    // Only hash the password if it has been modified (or is new)
    if (this.isModified('password') || this.isNew) {
      co(function*() {
        try {
          self.password = yield Bcrypt.hash(self.password, SALT_WORK_FACTOR);
          next();
        } catch (err) {
          next(err);
        }
      });
    } else {
      return next();
    }
  }
  get isLocked() {
    return !!(this.lockUntil && this.lockUntil > Date.now());
  }

  hasPassword() {
    return (this.password  && this.password.length > 0);
  }

  *incLoginAttempts() {
    // if we have a previous lock that has expired, restart at 1
    if (this.lockUntil && this.lockUntil < Date.now()) {
      yield this.update({
        $set: { loginAttempts: 1 },
        $unset: { lockUntil: 1 }
      });
    }
    // otherwise we're incrementing
    let updates = { $inc: { loginAttempts: 1 } };
    // lock the account if we've reached max attempts and it's not locked already
    if (this.loginAttempts + 1 >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
      updates.$set = { lockUntil: Date.now() + LOCK_TIME };
    }
    return yield this.update(updates);
  };


  static *matchUser(username, password) {

    let user = yield this.findOne({'username': username.toLowerCase()}).exec();

    // make sure the user exists
    if (!user) throw new AuthenticationError(failedLogin.NOT_FOUND, { message: 'User not found'});

    // check if the account is currently locked
    if (user.isLocked) {
      // just increment login attempts if account is already locked
      yield user.incLoginAttempts();
      throw new AuthenticationError(failedLogin.MAX_ATTEMPTS, { message: `The maximum number of failed login attempts has been reached. Wait for ${LOCK_TIME/1000} sec`});
    }

    // test for a matching password
    if (yield user.comparePassword(password)) {
      // if there's no lock or failed attempts, just return the user
      if (!user.loginAttempts && !user.lockUntil) {
        return user;
      }
      // reset attempts and lock info
      return yield user.update({
        $set: { loginAttempts: 0 },
        $unset: { lockUntil: 1 }
      });

    }

    // password is incorrect, so increment login attempts before responding
    yield user.incLoginAttempts();
    throw new AuthenticationError(failedLogin.PASSWORD_INCORRECT, { message: 'Password does not match'});
  }

  static *byEmail(email) {
    return yield this.findOne({email}).exec();
  }

  *comparePassword(candidatePassword) {
    // User password is not set yet
    if (!this.hasPassword()) {
      return false;
    }
    return yield Bcrypt.compare(candidatePassword, this.password);
  }

}
