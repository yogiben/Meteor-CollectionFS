/* CollectionFS.js
 * A gridFS kind implementation.
 * 2013-01-03
 * 
 * By Morten N.O. Henriksen, http://gi2.dk
 * 
 */

collectionFS = function(name, options) {
	var self = this;
	self._name = name;
	self.files = new Meteor.Collection(self._name+'.files'); //TODO: Add change listener?
	self.chunks = new Meteor.Collection(self._name+'.chunks');
	self.que = new _queCollectionFS(name);

//Auto subscribe
	if (Meteor.isClient) {
		Meteor.subscribe(self._name+'.files'); //TODO: needed if nullable?
	} //EO isClient	

	if (Meteor.isServer) {
	  Meteor.publish(self._name+'.files', function () { //TODO: nullable? autopublish?
	    return self.files.find({});
	  });		
	} //EO isServer

	var methodFunc = {};
	methodFunc['saveChunck'+self._name] = function(fileId, chunkNumber, countChunks, data) {
		var complete = (chunkNumber == countChunks - 1);
		var updateFiles = true; //(chunkNumber % 100 == 0); //lower db overheat on files record. eg. chunkNumber % 100 == 0
		var cId = null;
		if (Meteor.isServer && fileId) {
			var startTime = Date.now();
			cId = self.chunks.insert({
				//"_id" : <unspecified>,    // object id of the chunk in the _chunks collection
				"files_id" : fileId,    	// _id of the corresponding files collection entry
				"n" : chunkNumber,          // chunks are numbered in order, starting with 0
				"data" : data,          	// the chunk's payload as a BSON binary type			
			});

			/* Improve chunk index integrity have a look at TODO in uploadChunk() */
			if (cId) { //If chunk added successful
				if (complete || updateFiles)  //update file status
					self.files.update({ _id:fileId }, { 
						$set: { complete: complete, currentChunk: chunkNumber+1 }
					});
				//** Only update currentChunk if not complete? , complete: {$ne: true}
			} //If cId
		} //EO isServer
		return { fileId: fileId, chunkId: cId, complete: complete, currentChunk: chunkNumber+1, time: (Date.now()-startTime)};
	}; //EO saveChunck+name

	methodFunc['loadChunck'+self._name] = function(fileId, chunkNumber, countChunks) {
		var complete = (chunkNumber == countChunks-1);
		var chunk = null;
		if (Meteor.isServer && fileId) {
			var startTime = Date.now();
			chunk = self.chunks.findOne({
				//"_id" : <unspecified>,    // object id of the chunk in the _chunks collection
				"files_id" : fileId,    	// _id of the corresponding files collection entry
				"n" : chunkNumber          // chunks are numbered in order, starting with 0
				//"data" : data,          	// the chunk's payload as a BSON binary type			
			});

			return { fileId: fileId, chunkId: chunk._id, currentChunk:chunkNumber, complete: complete, data: chunk.data, time: (Date.now()-startTime) };
		} //EO isServer
	}; //EO saveChunck+name
	Meteor.methods(methodFunc); //EO Meteor.methods

}; //EO collectionFS

//var _queCollectionFS = {
_queCollectionFS = function(name) {
	var self = this;
	self._name = name;
	self.que = {};
	self.queLastTime = {};
	self.queLastTimeNr = 0;
	self.chunkSize = 1024; //256; //gridFS default is 256
	self.spawns = 50;
	//self.paused = false;
	self.listeners = {};
	self.lastTimeUpload = null;
	self.lastCountUpload = 0;
	self.lastTimeDownload = null;
	self.lastCountDownload = 0;	
	self.myCounter = 0;
	self.mySize = 0;
};
_.extend(_queCollectionFS.prototype, {
	addMeteorListeners: function(context) {
		//var context = Meteor.deps.Context.current; 
		var self = this;
		//XXX: is it posible error should be placed "in function"?
		if (context && !self.listeners[context.id]) {
		    self.listeners[context.id] = context;
		    context.onInvalidate(function () { delete self.listeners[context.id]; });
		} //EO Meteor listeners
	},

	getTimer: function(prefix, name) {
		var self = this;
		var myName = prefix+self._name+name;
		return Session.get(myName);
	},

	setTimer: function(prefix, name, time) {
		var self = this;
		var myName = prefix+self._name+name;
		Session.set(myName, time);
	},

	startTimer: function() {
		var self = this;
		var myIndex = self.queLastTimeNr++;
		self.queLastTime[myIndex] = Date.now();
		return myIndex;
	},

	getTimeQueLength: function() {
		var self = this;
		return Session.get(self._name+'queLastTimeLength');
	},

	stopTimer: function(prefix, name, index) {
		var self = this;
		var myName = prefix+self._name+name;
		var lastAvgTime = Session.get(myName);
		var avgTime = (lastAvgTime)?( Math.round( ((Date.now()-self.queLastTime[index]) + (lastAvgTime*9)) / 10 ) ):(Date.now()-self.queLastTime[index]);
		delete self.queLastTime[index]; //clean up
		var timeQueLength = 0;
		for (var a in self.queLastTime)
			timeQueLength++;
		Session.set(self._name+'queLastTimeLength', timeQueLength);
		Session.set(myName, avgTime);
	},
	//////////////////////////////////////////////////////////////////////////////////////////////////
	/////////////////////////////////////////// Getters //////////////////////////////////////////////
	//////////////////////////////////////////////////////////////////////////////////////////////////

	getItem: function(fileId) {
		var self = this;
		self.addMeteorListeners(Meteor.deps.Context.current);
		return self._getItem(fileId);
	}, //EO getItem	

	//_getItem is privat function, no meteor listeners
	_getItem: function(fileId) {
		var self = this;
		return self.que[fileId];
	}, //EO _getItem

	progress: function(fileId, onlyBuffer) {
		var self = this;
		var fileItem = self._getItem(fileId);
		if (!fileItem)
			return false;
		var pointerChunk = (onlyBuffer)?fileItem.currentChunk:fileItem.currentChunkServer; //TODO:
		self.addMeteorListeners(Meteor.deps.Context.current);
		if (fileItem)
			return Math.round(pointerChunk / (fileItem.countChunks) * 100)
		else
			return 0;
	},

	isComplete: function(fileId) {
		var self = this;
		self.addMeteorListeners(Meteor.deps.Context.current);
		return self._getItem(fileId).complete;
	}, //EO isComplete

	isDownloading: function(fileId) {
		var self = this;
		var fileItem = self._getItem(fileId);
		if (!fileItem)
			return false;
    	var myProgress1 = Filesystem.que.progress(fileId);
    	var myProgress2 = Math.round(fileItem.currentChunk / (fileItem.countChunks - 1) * 100);
	    return (Math.max(myProgress1, myProgress2) > 0 && Math.min(myProgress1, myProgress2) < 100 && !fileItem.file);
	},

	isDownloaded: function(fileId) {
		var self = this;
		self.addMeteorListeners(Meteor.deps.Context.current);
		var fileItem = self._getItem(fileId);
		if (fileItem.file)
			return true;
		if (fileItem.download) {
			return (fileItem.currentChunk == fileItem.countChunks-1);
		}
		return false;
	},

	isPaused: function() {
		var self = this;
		//self.addMeteorListeners(Meteor.deps.Context.current);
		return Session.get('_queCollectionFS.paused'); //self.paused; //use session instead
	},


	//////////////////////////////////////////////////////////////////////////////////////////////////
	/////////////////////////////////////////// Que //////////////////////////////////////////////////
	//////////////////////////////////////////////////////////////////////////////////////////////////
	//Bind to hot push code to resume after server reboot
	resume: function() {
		var self = this;
		Session.set('_queCollectionFS.paused', false);
		//self.paused = false;
		//console.log('paused:'+self.paused);
		for (var fileId in self.que) {
			var fileItem = self._getItem(fileId);
			if (fileItem.download) {
				self.downloadChunk(fileId);
			} else {
				//Spawn loaders
				for (var i = 0; i < self.spawns; i++)
					setTimeout(function() { self.getDataChunk(fileId); });
			}
		}
	}, //EO resume

	pause: function() {
		var self = this;
		Session.set('_queCollectionFS.paused', true);
		//self.paused = true;
		//que status changed
		//console.log('paused:'+self.paused);
		//for (var contextId in self.listeners)
    	//	self.listeners[contextId].invalidate();
	},

	resumeFile: function(fileRecord, file) {
		var self = this;
		var testFileRecord = self.makeGridFSFileRecord(file);
		if (self.compareFile(fileRecord, testFileRecord)) {
			self.addFile(fileRecord._id, file, fileRecord.currentChunk);
			return true;
		}
		//console.log('resumeFile - files dont match');
		return false; //Didnt compare - cant resumeFile
	}, //EO function
	//////////////////////////////////////////////////////////////////////////////////////////////////
	/////////////////////////////////////////// DOWNLOAD  ////////////////////////////////////////////
	//////////////////////////////////////////////////////////////////////////////////////////////////
	addDataChunk: function(fileId, chunckNumber, data) {
		var self = this;
		var filereaderTimer = self.startTimer();
		var fileItem = self._getItem(fileId);

	    var carry = [];
	    for(var i = 0; i < data.length; i++) {
	        carry.push(data.charCodeAt(i));
	    }

		self.que[fileId].queChunks[chunckNumber] = new Uint8Array(carry);//chunkBlob;
		self.stopTimer('download', 'filereader', filereaderTimer);
	},

	unionChunkBlobs: function(fileId) {
		var self = this;
		var fileItem = self._getItem(fileId);

		if (fileItem.queChunks.length == fileItem.countChunks) { //Last worker make chunks into blob
			self.que[fileId].blob = new Blob(fileItem.queChunks, { type: fileItem.contentType });
			fileItem.callback(self._getItem(fileId));
		}	
	},

	downloadChunk: function(fileId, optChunkNumber) {
		var self = this;
		var fileItem = self._getItem(fileId);
		var myChunkNumber = optChunkNumber || self.nextChunk(fileId);
		if (myChunkNumber === false)
			return false;

		self.lastCountDownload++;
		if (self.lastTimeDownload) {
			if (self.lastCountDownload == 10) {
				self.lastCountDownload = 0;
				var bitPrSecDownload = (8 * self.chunkSize * 10) / ((Date.now()-self.lastTimeDownload ) / 100);
				var oldBitPrSecDownload = (Session.get('bitPrSecDownload'))?Session.get('bitPrSecDownload'):bitPrSecDownload;
				Session.set('bitPrSecDownload', Math.round( (oldBitPrSecDownload*9 + bitPrSecDownload)/10) );
				self.lastTimeDownload = Date.now();
			}
		} else {
			self.lastTimeDownload = Date.now();
		}

		var timerTotal = self.startTimer();
		var timerMeteorCall = self.startTimer();

		Meteor.apply('loadChunck'+fileItem.collectionName, [
			fileId = fileId, 
			chunkNumber = myChunkNumber, 
			countChunks = fileItem.countChunks
		],[
			wait = true
		], 
			function(error, result) {
				//Callback
				self.stopTimer('download', 'meteorcall', timerMeteorCall);
				if (result.chunkId) {

					self.que[fileId].currentChunkServer = result.currentChunk+1;
					self.addDataChunk(fileId, myChunkNumber, result.data);
					var next = self.nextChunk(fileId);
					//console.log('Got: '+myChunkNumber+' next:'+next);
					self.setTimer('download', 'meteorcallserver', result.time);
					self.stopTimer('download', 'total', timerTotal);
					if (next) {
						self.downloadChunk(fileId, next);
					} else {
						if (self.que[fileId].queChunks.length == self.que[fileId].countChunks) {
							self.unionChunkBlobs(fileId);						
						} else {
							//console.log('Waiting for last arrivals');
						}
						//update and notify listenters

						if (fileItem.currentChunk % 1 == 0) {
							for (var contextId in self.listeners)
					    		self.listeners[contextId].invalidate();
						}
					}
				} 
			}//EO func
		);			
	}, //EO 

	// getFile callback(fileItem)
	getFile: function(fileRecord, callback, currentChunk) {
		var self = this;
		self.que[fileRecord._id] = {
			_id: fileRecord._id,
			download: true,
			complete: false,
			file: null,
			blob: null,
			queChunks: [],
			collectionName:self._name,
			contentType: fileRecord.contentType,
			currentChunkServer: (currentChunk)?currentChunk:0,
			currentChunk: (currentChunk)?currentChunk:0, //current loaded chunk of countChunks-1  
			countChunks: fileRecord.countChunks,
			callback: callback,
			len: fileRecord.len
		};

		//Added download request to the que
		for (var contextId in self.listeners)
    		self.listeners[contextId].invalidate();

		//Spawn loaders
		for (var i = 0; i < self.spawns; i++)
			setTimeout(function() { self.downloadChunk(fileRecord._id); });
	}, //EO 
	//////////////////////////////////////////////////////////////////////////////////////////////////
	/////////////////////////////////////////// UPLOAD ///////////////////////////////////////////////
	//////////////////////////////////////////////////////////////////////////////////////////////////
	
	addFile: function(fileId, file, currentChunk) {
		var self = this;
		var countChunks = Math.ceil(file.size / self.chunkSize);
		self.que[fileId] = {
			_id: fileId,
			download: false,
			complete: false,
			file: file,
			collectionName:self._name,
			currentChunkServer: (currentChunk)?currentChunk:0,
			currentChunk: (currentChunk)?currentChunk:0, //current loaded chunk of countChunks-1  
			countChunks: countChunks,
			//filereader: new FileReader(),	
		};
		//Added upload request to the que
		for (var contextId in self.listeners)
    		self.listeners[contextId].invalidate();
		
		//Spawn loaders
		for (var i = 0; i < self.spawns; i++)
			setTimeout(function() { self.getDataChunk(fileId); });
	}, //EO addFile

	getDataChunk: function(fileId, optChunkNumber) {
		var self = this;
		var myChunkNumber = optChunkNumber || self.nextChunk(fileId);
		if (myChunkNumber === false)
			return false;
		var f = self.que[fileId].file;
		var myreader = new FileReader();
		var start = myChunkNumber * self.chunkSize;
		//make sure not to exeed boundaries
		var stop = Math.min(start + self.chunkSize, f.size);
		var timerReader = self.startTimer();
		var slice = f.slice||f.webkitSlice||f.mozSlice;
		var blob = slice.call(f, start, stop, f.contentType);

		myreader.onloadend = function(evt) {
			if (evt.target.readyState == FileReader.DONE) {
				self.stopTimer('upload', 'filereader', timerReader);
				self.uploadChunk(fileId, myChunkNumber, evt.target.result);
			}
		};

		if (blob) {
			myreader.readAsBinaryString(blob);
		} else {
			throw new Error('Slice function not supported, fileId:'+fileId);
		}
	}, //EO get data chunk

	uploadChunk: function(fileId, chunkNumber, data) {
		var self = this;
		var fileItem = self._getItem(fileId);

		self.lastCountUpload++;
		if (self.lastTimeUpload) {
			if (self.lastCountUpload == 10) {
				self.lastCountUpload = 0;
				var bitPrSecUpload = (8 * self.chunkSize * 10) / ((Date.now()-self.lastTimeUpload ) / 100);
				var oldBitPrSecUpload = (Session.get('bitPrSecUpload'))?Session.get('bitPrSecUpload'):bitPrSecUpload;
				Session.set('bitPrSecUpload', Math.round( (oldBitPrSecUpload*9 + bitPrSecUpload)/10) );
				self.lastTimeUpload = Date.now();
			}
		} else {
			self.lastTimeUpload = Date.now();
		}

		var timerTotal = self.startTimer();
		var timerMeteorCall = self.startTimer();

		Meteor.apply('saveChunck'+fileItem.collectionName, [
			fileId = fileId, 
			currentChunk = chunkNumber, 
			countChunks = fileItem.countChunks, 
			data = data
		],[
			wait = true
		], function(error, result) {
				//Callback
				self.setTimer('upload', 'meteorcallserver', result.time);
				self.stopTimer('upload', 'meteorcall', timerMeteorCall);
				if (result.chunkId) {
					self.que[fileId].currentChunkServer = result.currentChunk;

					//TODO: Really, should the next function rule? or the result.currentChunk?
					//The result could be async? multiple users
					//Use in >saveChunk< function: 
					//	updating files $inc: { currentChunk: 0 } until == countChunks
					//	if not missing any chunks then complete else request client to upload by returning missing chunk number?
					//
					// var next = result.currentChunck;  //Chunck to download.. if not the save func gotta test fs.chunks index
					var next = self.nextChunk(result.fileId); //or let server decide
					//!result.complete && 
					if (next ) {
						self.getDataChunk(result.fileId, next);
					} else {


					}									
				} 
				self.stopTimer('upload', 'total', timerTotal);
			}

		);
	}, //uploadNextChunk
	//nextChunk returns next chunkNumber
	nextChunk: function(fileId) {
		var self = this;
		if (self.isPaused())
			return false;
//self.que[fileId].countChunks = 1; //Uncomment for debugging
		self.que[fileId].complete = (self.que[fileId].currentChunk == self.que[fileId].countChunks);
		//Que progressed
		for (var contextId in self.listeners)
    		self.listeners[contextId].invalidate();
		if (self.que[fileId].complete) {
			//done
			//XXX: Spawn complete event?
			return false;
		} else {
			if (!self.que[fileId].complete) { self.que[fileId].currentChunk++; }
			//XXX: Spawn progress event?
			return self.que[fileId].currentChunk-1;
		}
	}, //EO nextChunk
	//////////////////////////////////////////////////////////////////////////////////////////////////
	/////////////////////////////////////////// UTIL /////////////////////////////////////////////////
	//////////////////////////////////////////////////////////////////////////////////////////////////
	compareFile: function(fileRecordA, fileRecordB) {
		var errors = 0;
		var leaveOutField = {'_id':true, 'uploadDate':true, 'currentChunk':true };
		for (var fieldName in fileRecordA) {
			if (!leaveOutField[fieldName]) {
				if (fileRecordA[fieldName] != fileRecordB[fieldName]) {
					errors++; 
				}
			}
		} //EO for
		return (errors == 0);
	},
	makeGridFSFileRecord: function(file, options) {
		var self = this;
		var countChunks = Math.ceil(file.size / self.chunkSize);
		return {
		  chunkSize : self.chunkSize,
		  uploadDate : Date.now(),
		  md5 : null,
		  complete : false,
		  currentChunk: -1,
		  owner: Meteor.userId(),
		  countChunks: countChunks,
		  filename : file.name,
		  len : file.size,
		  contentType : file.type,
		  metadata : (options) ? options : null
		};
		//TODO:
		//XXX: Implement md5 later, guess every chunk should have a md5...
		//XXX:checkup on gridFS date format
		//ERROR: Minimongo error/memory leak? when adding attr. length to insert object
		//length : file.size,    gridFS size of the file in bytes, renamed ".len" to make it work?
	} //EO makeGridFSFileRecord

}); //EO

_.extend(collectionFS.prototype, {
	storeFile: function(file, options) {
		var self = this;
		if (Meteor.isClient) {
			var record = self.que.makeGridFSFileRecord(file, options);
			var fileId = self.files.insert(record);			
			//Put file in upload que
			self.que.addFile(fileId, file);
		}
		if (Meteor.isServer) {
			throw new Error("collectionFS server storeFile not implemented");
			//TODO: guess gridFS would work?
			//Java ex.
			//GridFS myFS = new GridFS(myDatabase);            // returns a default GridFS (e.g. "fs" bucket collection)
			//myFS.storeFile(new File("/tmp/largething.mpg")); // saves the file into the "fs" GridFS store
		}
	}, //EO storeFile
	//callback(fileItem)
	retrieveBlob: function(fileId, callback) {
		//console.log('retrieveBlob');
		var self = this;
		if (Meteor.isClient) {
			var fileItem = self.que._getItem(fileId);
			//if file blob in que, then use the file instead of downloading...
			if (fileItem &&(fileItem.file||fileItem.blob)) {
				//if file if blob
				callback(fileItem);		
			} else {	
				var fileRecord = self.files.findOne({ _id: fileId});
				//download into que file blob
				self.que.getFile(fileRecord, callback);
			}
			//return blob
		} //EO isClient	
	}, //EO retrieveBlob
	//getBlobAsUrl - seems to be the only way getting images into html via db - and files via <a download>
	getBlobAsUrl: function(fileId, callback) {}, //EO getBlobAsUrl
	retrieveImage: function(fileId, callback) {}, //EO retrieveImage
	retrieveText: function(fileId, callback) {}, //EO retrieveText
	retrieveFile: function(fileId, callback) {
		//check if found locally - then use directly
		//fetch from server, via methods call - dont want the chunks collection
	} //EO retriveFile

}); //EO extend collection