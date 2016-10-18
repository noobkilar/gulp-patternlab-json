var merge        = require('deepmerge');
var through      = require('through2');
var PluginError  = require('gulp-util').PluginError;
var fs           = require("fs");
var path         = require('path');
var jsbeautify   = require('js-beautify').js_beautify;

module.exports = function(opts) {
    var options = opts || {};
    var partialsData = {};
    var rootCallback;

    var isDir = function (filename) {
        var stats = fs.statSync(filename);
        return stats && stats.isDirectory();
    };

    var allowedExtensions = ['json'];
    var isGoodType = function (filename) {
        return allowedExtensions.indexOf(filename.split('.').pop()) !== -1;
    };

    var partialName = function (filename, base) {
        var name = path.join(path.dirname(filename), path.basename(filename, path.extname(filename)));
        if (name.indexOf(base) === 0) {
            name = name.slice(base.length);
        }
        // Change the name of the partial to use / in the partial name, not \
        name = name.replace(/\\/g, '/');

        // Remove leading _ and / character
        var firstChar = name.charAt(0);
        if( firstChar === '_' || firstChar === '/'  ){
            name = name.substring(1);
        }

        return name;
    };

    var registerPartial = function (filename, base) {
        if (!isGoodType(filename)) { return; }
        var name = partialName(filename, base);
        var template = fs.readFileSync(filename, 'utf8');
        partialsData[name] = template;
    };

    var maxDepth = 10;
    var registerPartials = function (dir, base, depth) {
        if (depth > maxDepth) { return; }
        base = base || dir;
        fs.readdirSync(dir).forEach(function (basename) {
            var filename = path.join(dir, basename);
            if (isDir(filename)) {
                registerPartials(filename, base);
            } else {
                registerPartial(filename, base);
            }
        });
    };

    if (options.batch) {
        if(typeof options.batch === 'string') options.batch = [options.batch];
        options.batch.forEach(function (dir) {
            dir = path.normalize(dir);
            registerPartials(dir, dir, 0);
        });
    }

    var helpers = {};
    if (options.helpers) {
        for (var h in options.helpers) {
            if(h == "parse" || h == "array") {return;}
            helpers[h] = options.helpers[h];
        }
    }

    var findExtended         = /([^@]*)@extends?\(([^)]*)\)/g;
    var findArray            = /([^@]*)@array?\((.*)\)/g;

    var findHelperName       = /^([^(]*)/g;
    var findHelperParameters = /\((.*)\)/g;

    function beginParsing(string) {
        var stringData = JSON.parse(string);
        var finalData  = parseOneLevel(stringData);

        return JSON.stringify(finalData);
    }

    function parseOneLevel(object) {
        var currentLevel;
        var templateText;

        if (typeof object === "object") {
            if (JSON.stringify(object).indexOf('{') == 0) {
                currentLevel = {};
                for (var key in object) {
                    var data = object[key];

                    if (key.match(findArray)) {
                        var arrayLength = 0;
                        key = key.replace(findArray, function(result, key, params) {
                            params = createParams(params);
                            arrayLength = Number(params[0]);
                            templateText = JSON.stringify(JSON.parse(partialsData[params[1]]));
                            return key;
                        });

                        var newData = [];
                        for (var i = 0; i < arrayLength; i++) {newData.push(mergeData(templateText, data));}
                        data = newData;
                    }

                    if (data !== "#") {
                        if (JSON.stringify(data).indexOf('#') == 1) {
                            data = executeHelper(data);
                        }
                    }

                    if (JSON.stringify(data).indexOf('{') == 0) {
                        data = parseOneLevel(data);
                    }

                    if (JSON.stringify(data).indexOf('[') == 0) {
                        data = parseOneLevel(data);
                    }

                    if (key.match(findExtended)) {
                        key = key.replace(findExtended, function(result, key, template) {
                            templateText = JSON.stringify(JSON.parse(partialsData[template]));
                            return key;
                        });

                        if (JSON.stringify(data).indexOf('[') == 0) {
                            var newData = [];
                            for (var i = 0; i < data.length; i++) {
                                newData.push(mergeData(templateText, data[i]));
                            }
                            data = newData;
                        } else {
                            data = mergeData(templateText, data);
                        }
                    }

                    currentLevel[key] = data;
                }
            } else if (JSON.stringify(object).indexOf('[') == 0) {
                currentLevel = [];
                for (var i = 0; i < object.length; i++) {
                    currentLevel.push(JSON.parse(beginParsing(JSON.stringify(object[i]))));
                }
            }
        } else {
            currentLevel = object;
        }

        return currentLevel;
    }

    function executeHelper(result) {
        var methodReturn = result;

        if (result.indexOf('(') != -1) {
            var helperName   = result.match(findHelperName)[0].slice(1);
            var helperParams = result.match(findHelperParameters)[0].slice(1, -1);
            if (!helpers[helperName]) {
                console.log("helper named :", '"' + helperName + '"', "cannot be executed");
            } else {
                var arrayParams  = createParams(helperParams);
                methodReturn = helpers[helperName].apply(null, arrayParams);
            }
        }

        return methodReturn;
    }

    function createParams(paramsString) {
        var fullParams = [];

        paramsString = parseParams(paramsString);
        paramsString = paramsString.replace(/ /g, '');
        paramsString.split(',').forEach(function(value, index) {
            value = getParam(value);
            if (typeof value === "string") {
                if (value.indexOf('{') == 0) {
                    value = JSON.parse(value);
                } else if (value.indexOf('[') == 0) {
                    value = JSON.parse(value);
                }
            }

            fullParams.push(value);
        });

        return fullParams;
    }

    function getParam(string) {

        if (typeof string === "string") {
            if (string.match(findArrayReplaced)) {
                string = string.replace(findArrayReplaced, function(match, result) {
                    result = arrays[result];
                    result = getParam(result);
                    return result;
                });
            } else if (string.match(findObjectReplaced)) {
                string = string.replace(findObjectReplaced, function(match, result) {
                    result = JSON.stringify(objects[result]);
                    result = getParam(result);
                    return result;
                });
            } else if (string.match(findHelpersInlineReplaced)) {
                string = string.replace(findHelpersInlineReplaced, function(match, result) {
                    result = executeHelper(helpersInline[result]);
                    result = getParam(result);
                    return result;
                });
            }
        }

        return string;
    }

    function mergeData(templateText, data) {
        templateText = beginParsing(templateText);
        data         = beginParsing(JSON.stringify(data));
        return merge(JSON.parse(templateText), JSON.parse(data));
    }

    var objects                   = {};
    var objectsIndex              = 1;
    var findParamsObject          = /({[^{}]*})/g;
    var findObjectReplaced        = /"?(\$\.O[0-9]*)"?/g;

    var arrays                    = {};
    var arraysIndex               = 1;
    var findParamsArray           = /(\[[^\[\]]*\])/g;
    var findArrayReplaced         = /"?(\$\.A[0-9]*)"?/g;

    var helpersInline             = {};
    var helpersInlineIndex        = 1;
    var findHelpersInline         = /"?#([a-z\u00C0-\u017F_0-9]*\([^"()]*\))"?/gi;
    var findHelpersInlineReplaced = /"?(\$\.H[0-9]*)"?/g;

    function parseParams(string) {
        string = tryToGetArrays(string);
        string = tryToGetObjects(string);
        string = tryToGetHelpers(string);
        return string;
    }


    function tryToGetArrays(fileText) {
        if (fileText.match(findParamsArray)) {
            fileText = fetchArray(fileText);
            fileText = tryToGetArrays(fileText);
        }

        return fileText;
    }

    function tryToGetObjects(fileText) {
        if (fileText.match(findParamsObject)) {
            fileText = fetchObject(fileText);
            fileText = tryToGetObjects(fileText);
        }

        return fileText;
    }

    function tryToGetHelpers(fileText) {
        if (fileText.match(findHelpersInline)) {
            fileText = fetchHelperInline(fileText);
            fileText = tryToGetHelpers(fileText);
        }

        return fileText;
    }

    function fetchArray(string) {
        string = string.replace(findParamsArray, function (match, result) {
            result = result.slice(1,-1);
            result = result.replace(/[ ]*,[ ]*/g, ',');

            if (result.match(findParamsArray)) {
                result = fetchArray(result);
            }

            if (result.match(findParamsObject)) {
                result = fetchObject(result);
            }

            if (result.match(findHelpersInline)) {
                result = fetchHelperInline(result);
            }

            var stringObject = "$.A" + arraysIndex;
            result = fakeArrayToRealArray(result);
            arrays[stringObject] = result;
            arraysIndex++;

            return stringObject;
        });
        return string;
    }

    function fetchObject(string) {
        string = string.replace(findParamsObject, function (match, result) {
            result = result.slice(1,-1);
            result = result.replace(/[ ]*,[ ]*/g, ',');
            result = result.replace(/[ ]*:[ ]*/g, ':');

            if (result.match(findParamsArray)) {
                result = fetchArray(result);
            }

            if (result.match(findParamsObject)) {
                result = fetchObject(result);
            }

            if (result.match(findHelpersInline)) {
                result = fetchHelperInline(result);
            }

            var stringObject = "$.O" + objectsIndex;
            result = fakeObjectToRealObject(result);
            objects[stringObject] = result;
            objectsIndex++;

            return stringObject;
        });
        return string;
    }

    function fetchHelperInline(string) {
        string = string.replace(findHelpersInline, function (match, result) {
            var helperName = result.match(findHelperName)[0];

            if (result.match(findParamsArray)) {
                result = fetchArray(result);
            }

            if (result.match(findParamsObject)) {
                result = fetchObject(result);
            }

            if (result.match(findHelpersInline)) {
                result = fetchHelperInline(result);
            }

            var stringObject = "$.H" + helpersInlineIndex;
            helpersInline[stringObject] = "#" + result;
            helpersInlineIndex++;

            return stringObject;
        });
        return string;
    }

    function fakeArrayToRealArray(data) {
        var final = [];

        if (data != "") {
            data = data.split(",");
            data.forEach(function(value, index) {
                final.push(formatString(value));
            });
        }

        return JSON.stringify(final);
    }

    function fakeObjectToRealObject(data) {
        var final = {};

        if (data != "") {
            data = data.split(",");
            data.forEach(function(value, index) {
                value = value.split(":");
                value[1] = formatString(value[1]);
                final[value[0]] = value[1];
            });
        }

        return final;
    }

    function formatString(string) {
        var data;

        if (string === "true" || string === "false") {
            data = (string === "true") ? true : false;
        } else if (Number(string)) {
            data = Number(string);
        } else if (string.indexOf('[') != -1) {
            data = [];
            var values = string.replace('[', '').replace(']', '').split(',');
            values.forEach(function(value, index) {
                value = formatString(value);
                data.push(value);
            });
        } else {
            data = String(string).replace(/"/g, '');
        }

        return data;
    }

    return through.obj(function (file, encoding, callback) {
        // ignore it
        if (file.isNull()) {
            this.push(file);
            return callback();
        }

        // stream is not supported
        if (file.isStream()) {
            this.emit('error', new PluginError('gulp-patternlab-json', 'Streaming is not supported'));
            return callback();
        }

        try {
            var self      = this;
            var fileText  = file.contents.toString('utf8');

            fileText      = beginParsing(fileText);
            fileText      = jsbeautify(fileText, {});

            if (options.replaceDash) {
                fileText      = fileText.replace(/"([a-z-_]*)"[ ]?:/gi, function($match, $result) {
                    $result = $result.replace(/-/g, '_');
                    return '"' + $result + '":';
                });
            }

            file.contents = new Buffer(fileText);
        }
        catch (err) {
            this.emit('error', new PluginError('gulp-json-editor', err));
        }

        self.push(file);
        callback();
    });
};