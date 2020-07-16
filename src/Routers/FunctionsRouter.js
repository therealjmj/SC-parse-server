// FunctionsRouter.js

var Parse = require('parse/node').Parse,
  triggers = require('../triggers');

import PromiseRouter from '../PromiseRouter';
import { promiseEnforceMasterKeyAccess, promiseEnsureIdempotency } from '../middlewares';
import { jobStatusHandler } from '../StatusHandler';
import _ from 'lodash';
import { logger } from '../logger';

function parseObject(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => {
      return parseObject(item);
    });
  } else if (obj && obj.__type == 'Date') {
    return Object.assign(new Date(obj.iso), obj);
  } else if (obj && obj.__type == 'File') {
    return Parse.File.fromJSON(obj);
  } else if (obj && typeof obj === 'object') {
    return parseParams(obj);
  } else {
    return obj;
  }
}

function parseParams(params) {
  return _.mapValues(params, parseObject);
}

export class FunctionsRouter extends PromiseRouter {
  mountRoutes() {
    this.route(
      'POST',
      '/functions/:functionName',
      promiseEnsureIdempotency,
      FunctionsRouter.handleCloudFunction
    );
    this.route(
      'POST',
      '/jobs/:jobName',
      promiseEnsureIdempotency,
      promiseEnforceMasterKeyAccess,
      function (req) {
        return FunctionsRouter.handleCloudJob(req);
      }
    );
    this.route('POST', '/jobs', promiseEnforceMasterKeyAccess, function (req) {
      return FunctionsRouter.handleCloudJob(req);
    });
  }

  static handleCloudJob(req) {
    const jobName = req.params.jobName || req.body.jobName;
    const applicationId = req.config.applicationId;
    const jobHandler = jobStatusHandler(req.config);
    const jobFunction = triggers.getJob(jobName, applicationId);
    if (!jobFunction) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Invalid job.');
    }
    let params = Object.assign({}, req.body, req.query);
    params = parseParams(params);
    const request = {
      params: params,
      log: req.config.loggerController,
      headers: req.config.headers,
      ip: req.config.ip,
      jobName,
      message: jobHandler.setMessage.bind(jobHandler),
    };

    return jobHandler.setRunning(jobName, params).then(jobStatus => {
      request.jobId = jobStatus.objectId;
      // run the function async
      process.nextTick(() => {
        Promise.resolve()
          .then(() => {
            return jobFunction(request);
          })
          .then(
            result => {
              jobHandler.setSucceeded(result);
            },
            error => {
              jobHandler.setFailed(error);

              // $JMJ: modified
              // Use handler defined in $error.js
              if (global.HandleJobError) {
                HandleJobError(jobName, params, JSON.stringify(error));
              }
            }
          );
      });
      return {
        headers: {
          'X-Parse-Job-Status-Id': jobStatus.objectId,
        },
        response: {},
      };
    });
  }

  static createResponseObject(userString /* $JMJ: Modified in fork. */, resolve, reject) {
    return {
      success: function (result) {
        resolve({
          response: {
            result: Parse._encode(result),
          },
        });
      },
      error: function (message) {

        // $JMJ: Modified in fork.
        if (message instanceof Error) {

          if (message instanceof global.CloudError) {
            message = message.message;
          } else {
            // Internal server crash
            console.error(message.stack)

            // Use handler defined in $error.js
            if (global.HandleServerCrash) {
              global.HandleServerCrash(message.stack, userString);
            }

            // Replace message with something like this.
            message = 'Something went wrong. Please try again or contact support.'
          }
        }

        const error = triggers.resolveError(message);
        reject(error);
      },
    };
  }
  static handleCloudFunction(req) {
    const functionName = req.params.functionName;
    const applicationId = req.config.applicationId;
    const theFunction = triggers.getFunction(functionName, applicationId);

    if (!theFunction) {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, `Invalid function: "${functionName}"`);
    }
    let params = Object.assign({}, req.body, req.query);
    params = parseParams(params);
    const request = {
      params: params,
      master: req.auth && req.auth.isMaster,
      user: req.auth && req.auth.user,
      installationId: req.info.installationId,
      log: req.config.loggerController,
      headers: req.config.headers,
      ip: req.config.ip,
      functionName,
      context: req.info.context,
    };

    return new Promise(function (resolve, reject) {
      const userString = req.auth && req.auth.user ? req.auth.user.id : undefined;
      const cleanInput = logger.truncateLogMessage(JSON.stringify(params));
<<<<<<< HEAD
      const { success, error } = FunctionsRouter.createResponseObject(
=======
      const { success, error, message } = FunctionsRouter.createResponseObject(
        userString, /* $JMJ: Modified in fork. */
>>>>>>> 758aadcd (Update)
        result => {
          try {
            const cleanResult = logger.truncateLogMessage(JSON.stringify(result.response.result));
            logger.info(
              `Ran cloud function ${functionName} for user ${userString} with:\n  Input: ${cleanInput}\n  Result: ${cleanResult}`,
              {
                functionName,
                params,
                user: userString,
              }
            );
            resolve(result);
          } catch (e) {
            reject(e);
          }
        },
        error => {
          try {
            logger.error(
              `Failed running cloud function ${functionName} for user ${userString} with:\n  Input: ${cleanInput}\n  Error: ` +
                JSON.stringify(error),
              {
                functionName,
                error,
                params,
                user: userString,
              }
            );
            reject(error);


            // $JMJ: modified
            // Use handler defined in $error.js
            if (global.HandleCloudFunctionError) {
              HandleCloudFunctionError(functionName, params, JSON.stringify(error), userString);
            }


          } catch (e) {
            reject(e);
          }
        }
      );
      return Promise.resolve()
        .then(() => {
          return triggers.maybeRunValidator(request, functionName, req.auth);
        })
        .then(() => {
          return theFunction(request);
        })
        .then(success, error);
    });
  }
}
