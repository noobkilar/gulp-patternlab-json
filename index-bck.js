var merge        = require('deepmerge');
var through      = require('through2');
var PluginError  = require('gulp-util').PluginError;
var fs           = require("fs");
var path         = require('path');
var jsbeautify   = require('js-beautify').js_beautify;

module.exports = function(opts) {
    var options = opts || {};
    var partialsData = {};

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

    helpers.parse = function(key, data, index) {
        var forceData = (data) ? data : {};
        if (objects[forceData]) {
            forceData = objects[forceData];
        }

        var dataFilled = JSON.stringify(JSON.parse(partialsData[key]));
        dataFilled     = JSON.parse(beginParsing(dataFilled));

        var result = merge(dataFilled, forceData);
        return result;
    }

    var objects            = {};
    var objectsIndex       = 1;
    var helpersInline      = {};
    var helpersInlineIndex = 1;
    var arrays             = {};
    var arraysIndex        = 1;

    var findHelperName       = /^([^(]*)/g;
    var findHelperParameters = /\((.*)\)/g;

    var findObject                = /({[^"{}]*})/g;
    var findObjectReplaced        = /"?(\$\.O[0-9]*)"?/g;
    var findArray                 = /"?(\[[^\[\]]*\])"?/g;
    var findArrayReplaced         = /"?(\$\.A[0-9]*)"?/g;
    var findHelpersInline         = /"?#([a-z\u00C0-\u017F_0-9]*\([^"()]*\))"?/gi;
    var findHelpersInlineReplaced = /"?(\$\.H[0-9]*)"?/g;

    function beginParsing(string) {
        string = tryToGetArrays(string);
        string = tryToGetObjects(string);
        string = tryToGetHelpers(string);

        string = drawArrays(string);
        string = drawObjects(string);
        string = drawHelperInlines(string);

        return string;
    }

    function tryToGetArrays(fileText) {
        if (fileText.match(findArray)) {
            fileText = fetchArray(fileText);
            fileText = tryToGetArrays(fileText);
        }

        return fileText;
    }

    function tryToGetObjects(fileText) {
        if (fileText.match(findObject)) {
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
        string = string.replace(findArray, function (match, result) {
            result = result.slice(1,-1);
            result = result.replace(/[ ]*,[ ]*/g, ',');

            if (result.match(findArray)) {
                result = fetchArray(result);
            }

            if (result.match(findObject)) {
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
        string = string.replace(findObject, function (match, result) {
            result = result.slice(1,-1);
            result = result.replace(/[ ]*,[ ]*/g, ',');
            result = result.replace(/[ ]*:[ ]*/g, ':');

            if (result.match(findArray)) {
                result = fetchArray(result);
            }

            if (result.match(findObject)) {
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

            if (helperName == "array") {
                result = arrayReplace(result);
            }

            if (result.match(findArray)) {
                result = fetchArray(result);
            }

            if (result.match(findObject)) {
                result = fetchObject(result);
            }

            if (result.match(findHelpersInline)) {
                result = fetchHelperInline(result);
            }

            if (helperName == "array") {
                return result;
            }

            var stringObject = "$.H" + helpersInlineIndex;
            helpersInline[stringObject] = result;
            helpersInlineIndex++;

            return stringObject;
        });
        return string;
    }

    function drawArrays(fileText) {
        if (fileText.match(findArrayReplaced)) {
            fileText = drawArray(fileText);
            fileText = drawArrays(fileText);
        }

        return fileText;
    }

    function drawObjects(fileText) {
        if (fileText.match(findObjectReplaced)) {
            fileText = drawObject(fileText);
            fileText = drawObjects(fileText);
        }

        return fileText;
    }

    function drawHelperInlines(fileText) {
        if (fileText.match(findHelpersInlineReplaced)) {
            fileText = drawHelperInline(fileText);
            fileText = drawHelperInlines(fileText);
        }

        return fileText;
    }

    function drawArray(string) {
        string = string.replace(findArrayReplaced, function (match, result) {
            result = JSON.stringify(arrays[result]);

            if (result.match(findArrayReplaced)) {
                result = drawArrays(result);
            }

            if (result.match(findObjectReplaced)) {
                result = drawObjects(result);
            }

            if (result.match(findHelpersInlineReplaced)) {
                result = drawHelperInlines(result);
            }

            return result;
        });

        return string;
    }

    function drawObject(string) {
        string = string.replace(findObjectReplaced, function (match, result) {
            result = JSON.stringify(objects[result]);

            if (result.match(findArrayReplaced)) {
                result = drawArrays(result);
            }

            if (result.match(findObjectReplaced)) {
                result = drawObjects(result);
            }

            if (result.match(findHelpersInlineReplaced)) {
                result = drawHelperInlines(result);
            }

            return result;
        });

        return string;
    }

    function drawHelperInline(string) {
        string = string.replace(findHelpersInlineReplaced, function (match, result) {
            result = helpersInline[result];
            result = returnData(result);

            if (result.match(findArrayReplaced)) {
                result = drawArrays(result);
            }

            if (result.match(findObjectReplaced)) {
                result = drawObjects(result);
            }

            if (result.match(findHelpersInlineReplaced)) {
                result = drawHelperInlines(result);
            }

            return result;
        });

        return string;
    }

    function fakeArrayToRealArray(data) {
        var final = [];

        if (data != "") {
            data = data.split(",");
            data.forEach(function(value, index) {
                final.push(value);
            });
        }

        return final;
    }

    function fakeObjectToRealObject(data) {
        var final = {};

        if (data != "") {
            data = data.split(",");
            data.forEach(function(value, index) {
                value = value.split(":");
                value[1] = formatString(String(value[1]));
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

    function arrayReplace(string) {
        string = string.slice(string.indexOf('(')+1, -1);
        string = string.replace(/[ ]*,[ ]*/, ',');
        string = string.split(',');

        string[0] = beginParsing(string[0]);
        string[1] = beginParsing(string[1]);

        string = arrayCreator(string[0], string[1], string[2]);

        return string;
    }

    function arrayCreator(length, key, data) {
        var dataArray = [];

        for(var i = 1; i <= length; i++) {
            var parseText = "";
            parseText += "#parse(";
            parseText += key;
            if (data) {
                parseText += "," + data;
            }
            parseText += ")";
            dataArray.push(parseText);
        }

        return JSON.stringify(dataArray);
    }

    function createParams(paramsString) {
        var fullParams = [];

        paramsString = paramsString.replace(/ /g, '');
        paramsString.split(',').forEach(function(value, index) {
            value = getParam(value);
            if (value.indexOf('{') == 0) {
                value = JSON.parse(value);
            }
            fullParams.push(value);
        });

        return fullParams;
    }

    function getParam(string) {
        if (string.match(findArrayReplaced)) {
            string = string.replace(findArrayReplaced, function(match, result) {
                result = JSON.stringify(arrays[result]);
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
                result = returnData(helpersInline[result]);
                result = getParam(result);
                return result;
            });
        }

        return string;
    }

    function returnData(result) {
        var helperName   = result.match(findHelperName)[0];
        var helperParams = result.match(findHelperParameters)[0].replace('(', '').replace(')', '');
        var arrayParams  = createParams(helperParams);

        var methodReturn = helpers[helperName].apply(null, arrayParams);

        if (typeof methodReturn === "object") {
            methodReturn = JSON.parse(JSON.stringify(methodReturn));

            var stringObject = "$.O" + objectsIndex;
            objects[stringObject] = methodReturn;
            objectsIndex++;

            methodReturn = stringObject;
        }

        if (helperName != "parse") {
            methodReturn = JSON.stringify(methodReturn);
        }

        return methodReturn;
    }

    return through.obj(function (file, encoding, callback) {
        // ignore it
        if (file.isNull()) {
            this.push(file);
            return callback();
        }

        // stream is not supported
        if (file.isStream()) {
            this.emit('error', new PluginError('gulp-json-editor', 'Streaming is not supported'));
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
            self.emit('error', new PluginError('gulp-json-editor', err));
        }

        self.push(file);
        callback();
    });
};