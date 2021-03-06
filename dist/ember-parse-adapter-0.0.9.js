var ParseConnector = Ember.Mixin.create({

  /*
    We'll need all three since we're doing both REST API calls
    as well as the transliterated calls via JavaScript for
    CORS in Internet Explorer.
  */
  applicationId: null,
  javascriptId: null,
  restApiId: null,

  serverUrl: "https://api.parse.com",
  versionPath: "1",
  modelPath: "classes",

  /*
    Be sure that on every attempt to Parse API we have proper account
    information.
  */
  requestHeaders: function(){
    if(!this.applicationId || !this.restApiId || !this.javascriptId){
      throw "Hey! You forgot to set your Parse Account info! https://parse.com/apps/";
    }
    return {
      "X-Parse-Application-Id": this.applicationId,
      "X-Parse-REST-API-Key": this.restApiId
    };
  },

  /*
    Clearly this is stolen from the original Parse JavaScript SDK.
  */
  xDomainRequest: function(method, url, data, success, error){
    var xdr = new XDomainRequest();
    // transliterate to POST if not already
    if(method !== "POST"){
      data._method = method;
      method = "POST";
    }
    // add acct info to the data (notice not the REST key!)
    data._ApplicationId = this.applicationId;
    data._JavaScriptKey = this.javascriptId;
    // make the data ready for the POST body
    data = JSON.stringify(data);

    xdr.onload = function() {
      var response;
      try {
        response = JSON.parse(xdr.responseText);
      } catch (e) {
        if (error) {
          error(xdr);
        }
      }
      if (response) {
        if (success) {
          success(response, xdr);
        }
      }
    };
    xdr.onerror = xdr.ontimeout = function() {
      if(error){
        error(xdr);
      }
    };
    xdr.onprogress = function() {};
    xdr.open(method, url);
    xdr.send(data);
  },

  ajax: function(method, url, hash){
    // If XDomainRequest exists this is IE, treat the whole request differently
    if(typeof(XDomainRequest) !== 'undefined'){
      return this.xDomainRequest(method, url, hash.data, hash.success, hash.error);
    }

    var ajaxOptions = {
      url: url,
      context: this,
      type: method,
      headers: this.requestHeaders(),
      success: hash.success,
      error: hash.error,
      contentType: 'text/plain'
    };

    if(method !== "GET" && method !== "DELETE"){
      $.extend(ajaxOptions, {
        data: JSON.stringify(hash.data)
      });
    }

    jQuery.ajax(ajaxOptions);

  },

  /**
   * Abstracted AJAX function to setup options for the real AJAX call
   * @param  {String} method  GET/POST/PUT/DELETE
   * @param  {String} model   string name of the class/type we're sending
   * @param  {String} id      identifier for the record (objectId in Parse)
   * @param  {Object} data    POST/PUT body data
   * @param  {Object} options hash for AJAX (success/error callbacks)
   */
  request: function(method, model, id, data, options){

    if(Ember.typeOf(id) === 'object'){
      options = data;
      data = id;
      id = null;
    }

    if(Ember.typeOf(data) === 'object' && !options){
      options = data;
      data = {};
    }

    this.ajax(method, this.buildUrl(model, id),
      {data: data, success: options.success, error: options.error});
  },

  batchRequest: function(data, options){
    var url = "%@/%@/batch".fmt(this.serverUrl, this.versionPath);
    this.ajax("POST", url, {data: data, success: options.success, error: options.error});
  },

  /**
   * Creates a URL to use for the HTTP request to Parse
   * @param  {String} parseClass  string of the type/class in the URL
   * @param  {String} id          string identifier (objectId in Parse, id in Ember)
   */
  buildUrl: function(parseClass, id){
    var modelUrl;
    if(parseClass === 'DS.ParseUser'){
      modelUrl = "%@/%@/%@".fmt(this.serverUrl, this.versionPath, "users");
    } else {
      modelUrl = "%@/%@/%@/%@".fmt(this.serverUrl, this.versionPath, this.modelPath, parseClass);
    }
    if(id){
      modelUrl += "/" + id;
    }
    return modelUrl;
  }
});

/*
  Serializer to assure proper Parse-to-Ember encodings
*/
var ParseJSONSerializer = DS.JSONSerializer.extend({

  primaryKey: function(){
    return "objectId";
  },

  /*
    If supplied with a Parse type use that
    otherwise use the name of the Model from the namespace.
  */
  getTypeName: function(type){
    if(type === ParseUser || type.superclass === ParseUser) return ParseUser.toString();
    if(type.parseType) return type.parseType;
    var namespace = type.toString().split('.');
    return namespace[namespace.length-1];
  },

  /*
    In order to make use of the default DS.JSONSerializer
    we need to 'root' our JSON objects with the name of the
    type (pluralized for collections).
  */
  serializeRootObject: function(type, data){
    var root = this.rootForType(type),
      obj = {};
      if(Ember.isArray(data)) {
        root = this.pluralize(root);
      }
      obj[root] = data;
      return obj;
  },

  /*
    Parse API provides a batch request and this packages
    the records into the format necessary to batch.
    See: https://parse.com/docs/rest#objects-batch
  */
  serializeBatchFor: function(method, records){
    var batch = { requests: [] }, adapter = this.get('adapter');
    records.forEach(function(record){
      var request = {}, typeName = this.getTypeName(record.constructor);
      request.method = method;
      request.path = "/%@/%@/%@".fmt(this.versionPath, this.modelPath, typeName);
      request.body = this.serialize(record, {includeId: true});
      batch.requests.push(request);
    }, this);
    return batch;
  },

  /*
    Parse uses an encoding for Pointer to associate records.
    See: https://www.parse.com/docs/rest#objects-types
  */
  addHasMany: function(hash, record, key, relationship){
    if(relationship.options.embedded){
      // DS.JSONSerializer handles the embedded case
      this._super.apply(this, arguments);
    } else {
      var array = [];
      // Serialize each child that has an ID as a Parse Pointer to help with bulk finds
      record.get(key).forEach(function(child){
        var adapter = child.store.get('adapter');
        // makes an assumption that the ParseAdapter is the only game in town
        if(child.get('id')){
          array.push({
            "__type": "Pointer",
            "className": adapter.getTypeName(child.constructor),
            "objectId": child.get('id')
          });
        } else {
          throw "Can I see your ID please?!?!";
        }
      });
      hash[key] = array;
    }
  }

});
/**
 * An Ember Data Adapter written to use Parse REST API
 * @type {DS.Adapter}
 */
var ParseAdapter = DS.Adapter.extend(ParseConnector, {

  /*
    You could change this, but Parse counts API requests so
    why not batch your stuff and keep your requests count low?
    See: https://parse.com/docs/rest#objects-batch
  */
  bulkCommit: true,

  serializer: ParseJSONSerializer,

  /**
   * Override of the initialization to set properties on
   * the Serializer.
   */
  init: function(){
    this._super.apply(this, arguments);
    var serializer = this.get('serializer');
    serializer.versionPath = this.get('versionPath');
    serializer.modelPath = this.get('modelPath');
  },

  /**
   * Implementation of the Find by ID
   * @param  {DS.Store} store the store of the model
   * @param  {DS.Model} type  Model used in the Find
   * @param  {String} id    identifier to query
   */
  find: function(store, type, id){
    var model = this.getTypeName(type);
    this.request("GET", model, id, {
      success: function(data){
        Ember.run(this, function(){
          this.didFindRecord(store, type, this.makeRootObject(type, data), id);
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::find::error', error);
      }
    });
  },

  findAll: function(store, type, since){
    var model = this.getTypeName(type);
    this.request("GET", model, {
      success: function(data){
        Ember.run(this, function(){
          this.didFindAll(store, type, this.makeRootObject(type, data.results));
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::findAll::error', error);
      }
    });
  },

  findMany: function(store, type, ids){
    var model = this.getTypeName(type);
    this.request("POST", model, {where: {objectId: {"$in": ids.join(",")}}}, {
      success: function(data){
        Ember.run(this, function(){
          this.didFindMany(store, type, this.makeRootObject(type, data.results));
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::findMany::error', error);
      }
    });
  },

  findQuery: function(store, type, query, records){
    var model = this.getTypeName(type);
    this.request("POST", model, {where: query}, {
      success: function(data){
        Ember.run(this, function(){
          this.didFindQuery(store, type, this.makeRootObject(type, data.results), records);
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::findQuery::error', error);
      }
    });
  },

  createRecord: function(store, type, record){
    var model = this.getTypeName(type),
      data = this.serialize(record, {includeId: true});
    this.request("POST", model, data, {
      success: function(result){
        Ember.run(this, function(){
          // Parse will always return "objectId" and "createdAt"
          $.extend(data, result);
          this.didCreateRecord(store, type, record, this.makeRootObject(type, data));
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::createRecord::error', error);
      }
    });
  },

  createRecords: function(store, type, records){
    if (this.get('bulkCommit') === false) {
      return this._super(store, type, records);
    }
    var batch = this.makeBatchFor("POST", records);
    this.batchRequest(batch, {
      success: function(json){
        var extendedRecords = this.extendRecords(json.results, batch);
        Ember.run(this, function(){
          this.didCreateRecords(store, type, records, this.makeRootObject(type, extendedRecords));
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::createRecords::error', error);
      }
    });
  },

  updateRecord: function(store, type, record){
    var model = this.getTypeName(type),
      data = this.serialize(record, {includeId: true});
    this.request("PUT", model, data.objectId, data, {
      success: function(result){
        Ember.run(this, function(){
          // Parse will always return "objectId" and "updatedAt"
          $.extend(data, result);
          this.didUpdateRecord(store, type, record, this.makeRootObject(type, data));
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::updateRecord::error', error);
      }
    });
  },

  updateRecords: function(store, type, records){
    if (this.get('bulkCommit') === false) {
      return this._super(store, type, records);
    }
    var batch = this.makeBatchFor("PUT", records);
    this.batchRequest(batch, {
      success: function(json){
        var extendedRecords = this.extendRecords(json.results, batch);
        Ember.run(this, function(){
          this.didUpdateRecords(store, type, records, this.makeRootObject(type, extendedRecords));
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::updateRecords::error', error);
      }
    });
  },

  deleteRecord: function(store, type, record){
    var model = this.getTypeName(type),
      data = this.serialize(record, {includeId: true});
    this.request("DELETE", model, data.objectId, {
      success: function(result){
        Ember.run(this, function(){
          this.didDeleteRecord(store, type, record);
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::deleteRecord::error', error);
      }
    });
  },

  deleteRecords: function(store, type, records){
    if (this.get('bulkCommit') === false) {
      return this._super(store, type, records);
    }
    //TODO: Maybe we could shrink the payload? No need for full body requests.
    var batch = this.makeBatchFor("DELETE", records);
    this.batchRequest(batch, {
      success: function(json){
        //TODO: We do want to tease out the success/error in the results object?
        Ember.run(this, function(){
          this.didDeleteRecords(store, type, records);
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::deleteRecords::error', error);
      }
    });
  },

  /*
    Expiremental: This is an idea to totally concat all the transactions
    together. This would work within an override of the commit method so as
    to receive the commitDetails object in order to collect all commit types.
  */
  batchCommit: function(commits){
    var updates = this.makeBatchFor("PUT", commits.updated);
    var deletes = this.makeBatchFor("DELETE", commits.deleted);
    var creates = this.makeBatchFor("POST", commits.created);
    var batch = { requests: creates.requests.concat(updates.requests.concat(deletes.requests)) };
    var adapter = this;

    this.batchRequest(batch, {
      success: function(json){
        // TODO: Need to reconcile the creates with their new objectIds somehow.
        Ember.run(adapter, function(){
            adapter.didSaveRecords(store, type, set);
        });
      },
      error: function(error){
        Ember.Logger.error('Adapter::batchCommit::error', error);
      }
    });
  },

  /*
    When Parse API returns results they are wrapped in success/error
    objects and this function extends the records with the request
    result based on success/error.
  */
  extendRecords: function(json, batch){
    var extendedRecords = batch.requests.map(function(request, index){
      var result = json[index];
      if(result.success){
        return $.extend(request.body, result.success);
      } else {
        // TODO: Is this something worth halting for?
        return request.body;
      }
    });
    return extendedRecords;
  },

  getTypeName: function(type){
    return this.get('serializer').getTypeName(type);
  },

  makeRootObject: function(type, data){
    return this.get('serializer').serializeRootObject(type, data);
  },

  makeBatchFor: function(method, records){
    return this.get('serializer').serializeBatchFor(method, records);
  }

});

/*
  Parse uses ISO 8601 format strings so we change just the default serialization.
  See: https://parse.com/docs/rest#objects-types
*/
ParseAdapter.registerTransform('date', {

    deserialize: DS.JSONTransforms.date.deserialize,

    serialize: function(date){
      if(date instanceof Date){
        return date.toISOString();
      } else if(date === undefined){
        return undefined;
      } else {
        return null;
      }
    }

});

var ParseMixin = Ember.Mixin.create({
  createdAt: DS.attr('date'),
  updatedAt: DS.attr('date')
});

var ParseModel = DS.ParseModel = DS.Model.extend(ParseMixin);
/**
 * An implementation of the User object provided from Parse.
 * @type {ParseModel}
 */
var ParseUser = DS.ParseUser = ParseModel.extend({

  username: DS.attr('string'),
  email: DS.attr('string'),
  password: DS.attr('string'),
  sessionToken: DS.attr('string'),

  /**
   * Implementation of the signup process from Parse.
   * See: https://parse.com/docs/rest#users-signup
   * @param  {Object} attrs optional hash of User username and password
   */
  signup: function(attrs){
    var username = (attrs && attrs.username) || this.get("username"),
      password = (attrs && attrs.password) || this.get("password"),
      store = this.store,
      adapter = this.store.adapter,
      data,
      record = this;

    if(!username && !password){
      throw 'Hey - you cannot signup without all this stuff man!';
    }

    this.set('username', username);
    this.set('password', password);

    // make this model conform to standard eventing
    this.send('willCommit');

    data = adapter.get('serializer').serialize(this);

    adapter.request("POST", ParseUser.toString(), data, {
      success: function(result){
        Ember.run(this, function(){
          $.extend(data, result);
          // TODO: Check into the type/record weirdness here.
          this.didCreateRecord(store, record, record, this.makeRootObject(record, data));
          record.set('sessionToken', result.sessionToken);
          record.set('password', null);
        });
      },
      error: function(result){
        // TODO: Errors to handle
        // {"code":202,"error":"username clintjhill already taken"}
        // {"code":203,"error":"the email address clint.hill@goaaa.com has already been taken"}
      }
    });

  },

  /**
   * Implementation of the login process from Parse.
   * See: https://parse.com/docs/rest#users-login
   * @param  {Object} attrs hash of User username and password
   */
  login: function(attrs){
    var username = (attrs && attrs.username) || this.get("username"),
      password = (attrs && attrs.password) || this.get("password");
    // GET to /login
  },

  /**
   * Implementation of the current user status. Needs better work
   * @return {Boolean} whether the user is the one associated to the session token
   */
  isCurrent: function(){
    // TODO: Just because we have a session token doesn't mean we're current right?
    return this.get('sessionToken');
  }.property('sessionToken')

});