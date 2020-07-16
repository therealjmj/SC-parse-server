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

  static createResponseObject(userString /* $JMJ: Modified in fork. */, resolve, reject, message) {
    return {
      success: function (result) {
        resolve({
          response: {
            result: Parse._encode(result),
          },
        });
      },
      error: function (message) {
        // parse error, process away
        if (message instanceof Parse.Error) {
          return reject(message);
        }

        const code = Parse.Error.SCRIPT_FAILED;
        // If it's an error, mark it as a script failed
        if (typeof message === 'string') {
          return reject(new Parse.Error(code, message));
        }

        
        
        // $JMJ: Modified in fork.
        if (message instanceof Error) {

          if (message instanceof CloudError) {
            message = message.message;
          } else {
            // Internal server crash
            console.error(message.stack)

            // Use handler defined in $error.js
            if (global.HandleServerCrash) {
              HandleServerCrash(message.stack, userString);
            }

            // Replace message with something like this.
            message = 'Something went wrong. Please try again or contact support.'
          }
        }

        // if (message instanceof Error) {
        //   message = message.message;
        // }


        reject(new Parse.Error(code, message));
      },
      message: message,
    };
  }

  static handleCloudFunction(req) {
    const functionName = req.params.functionName;
    const applicationId = req.config.applicationId;
    const theFunction = triggers.getFunction(functionName, applicationId);
    const theValidator = triggers.getValidator(
      req.params.functionName,
      applicationId
    );
    if (!theFunction) {
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        `Invalid function: "${functionName}"`
      );
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

    if (theValidator && typeof theValidator === 'function') {
      var result = theValidator(request);
      if (!result) {
        throw new Parse.Error(
          Parse.Error.VALIDATION_ERROR,
          'Validation failed.'
        );
      }
    }

    return new Promise(function (resolve, reject) {
      const userString =
        req.auth && req.auth.user ? req.auth.user.id : undefined;
      const cleanInput = logger.truncateLogMessage(JSON.stringify(params));
      const { success, error, message } = FunctionsRouter.createResponseObject(
        userString, /* $JMJ: Modified in fork. */
        result => {
          try {
            const cleanResult = logger.truncateLogMessage(
              JSON.stringify(result.response.result)
            );
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
          return theFunction(request, { message });
        })
        .then(success, error);
    });
  }
}
