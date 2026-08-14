#include <node_api.h>

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#include <memory>
#include <string>

namespace {

struct AuthorizationResult {
  std::string error;
  std::string permission;
};

std::string messageForException(NSException* exception) {
  NSString* message = exception.reason ?: exception.name;
  if (message == nil) return "macOS notification authorization raised an exception";
  const char* utf8 = message.UTF8String;
  return utf8 == nullptr ? "macOS notification authorization raised an exception" : utf8;
}

void deliver(napi_threadsafe_function function, AuthorizationResult* result) {
  const napi_status status = napi_call_threadsafe_function(function, result, napi_tsfn_nonblocking);
  if (status != napi_ok) delete result;
  napi_release_threadsafe_function(function, napi_tsfn_release);
}

std::string permissionForStatus(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusAuthorized:
    case UNAuthorizationStatusProvisional:
      return "granted";
    case UNAuthorizationStatusDenied:
      return "denied";
    case UNAuthorizationStatusNotDetermined:
      return "unknown";
  }
  return "unknown";
}

void callJavaScript(
    napi_env environment,
    napi_value callback,
    void*,
    void* rawResult) {
  std::unique_ptr<AuthorizationResult> result(static_cast<AuthorizationResult*>(rawResult));
  if (environment == nullptr || callback == nullptr) return;
  napi_value undefined;
  napi_get_undefined(environment, &undefined);
  napi_value arguments[2];
  napi_get_null(environment, &arguments[0]);
  napi_get_null(environment, &arguments[1]);
  if (result->error.empty()) {
    napi_create_string_utf8(
        environment,
        result->permission.c_str(),
        result->permission.size(),
        &arguments[1]);
  } else {
    napi_create_string_utf8(
        environment,
        result->error.c_str(),
        result->error.size(),
        &arguments[0]);
  }
  napi_call_function(environment, undefined, callback, 2, arguments, nullptr);
}

void reportSettings(
    UNUserNotificationCenter* center,
    napi_threadsafe_function function) {
  @try {
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
      @try {
        auto* result = new AuthorizationResult{
            .error = "",
            .permission = permissionForStatus(settings.authorizationStatus),
        };
        deliver(function, result);
      } @catch (NSException* exception) {
        auto* result = new AuthorizationResult{
            .error = messageForException(exception),
            .permission = "",
        };
        deliver(function, result);
      }
    }];
  } @catch (NSException* exception) {
    auto* result = new AuthorizationResult{
        .error = messageForException(exception),
        .permission = "",
    };
    deliver(function, result);
  }
}

napi_value authorize(napi_env environment, napi_callback_info callbackInfo) {
  size_t argumentCount = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, callbackInfo, &argumentCount, arguments, nullptr, nullptr);
  if (argumentCount != 2) {
    napi_throw_type_error(environment, nullptr, "Expected command and callback");
    return nullptr;
  }

  napi_valuetype callbackType;
  napi_typeof(environment, arguments[1], &callbackType);
  if (callbackType != napi_function) {
    napi_throw_type_error(environment, nullptr, "Expected callback function");
    return nullptr;
  }

  size_t commandLength = 0;
  if (napi_get_value_string_utf8(environment, arguments[0], nullptr, 0, &commandLength) != napi_ok ||
      commandLength > 16) {
    napi_throw_type_error(environment, nullptr, "Expected status or request");
    return nullptr;
  }
  std::string command(commandLength, '\0');
  napi_get_value_string_utf8(
      environment,
      arguments[0],
      command.data(),
      command.size() + 1,
      &commandLength);
  if (command != "status" && command != "request") {
    napi_throw_type_error(environment, nullptr, "Expected status or request");
    return nullptr;
  }

  napi_value resourceName;
  napi_create_string_utf8(
      environment,
      "Hype Comms notification authorization",
      NAPI_AUTO_LENGTH,
      &resourceName);
  napi_threadsafe_function function;
  const napi_status createStatus = napi_create_threadsafe_function(
      environment,
      arguments[1],
      nullptr,
      resourceName,
      0,
      1,
      nullptr,
      nullptr,
      nullptr,
      callJavaScript,
      &function);
  if (createStatus != napi_ok) {
    napi_throw_error(environment, nullptr, "Could not create authorization callback");
    return nullptr;
  }

  @try {
    UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
      @try {
        if (command == "request" &&
            settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
          [center requestAuthorizationWithOptions:
                      (UNAuthorizationOptionAlert | UNAuthorizationOptionBadge |
                       UNAuthorizationOptionSound)
                                completionHandler:^(BOOL, NSError* error) {
            @try {
              if (error != nil) {
                const char* description = error.localizedDescription.UTF8String;
                auto* result = new AuthorizationResult{
                    .error = description == nullptr ? "macOS notification authorization failed"
                                                    : description,
                    .permission = "",
                };
                deliver(function, result);
                return;
              }
              reportSettings(center, function);
            } @catch (NSException* exception) {
              auto* result = new AuthorizationResult{
                  .error = messageForException(exception),
                  .permission = "",
              };
              deliver(function, result);
            }
          }];
          return;
        }
        auto* result = new AuthorizationResult{
            .error = "",
            .permission = permissionForStatus(settings.authorizationStatus),
        };
        deliver(function, result);
      } @catch (NSException* exception) {
        auto* result = new AuthorizationResult{
            .error = messageForException(exception),
            .permission = "",
        };
        deliver(function, result);
      }
    }];
  } @catch (NSException* exception) {
    auto* result = new AuthorizationResult{
        .error = messageForException(exception),
        .permission = "",
    };
    deliver(function, result);
  }

  napi_value undefined;
  napi_get_undefined(environment, &undefined);
  return undefined;
}

napi_value initialize(napi_env environment, napi_value exports) {
  napi_value function;
  napi_create_function(environment, "authorize", NAPI_AUTO_LENGTH, authorize, nullptr, &function);
  napi_set_named_property(environment, exports, "authorize", function);
  return exports;
}

}  // namespace

NAPI_MODULE(hmm_notification_authorization, initialize)
