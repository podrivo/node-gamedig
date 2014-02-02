module.exports = require('./protocols/valve').extend({
	init: function() {
		this._super();
		this.pretty = 'Frontlines: Fuel of War';
		this.options.port = 5478;
		this.byteorder = 'be';
		this.legacyChallenge = true;
	},
	queryInfo: function(state,c) {
		var self = this;
		self.sendPacket(0x46,false,'LSQ',0x49,function(b) {
			var reader = self.reader(b);

			state.raw.protocol = reader.uint(1);
			state.name = reader.string();
			state.map = reader.string();
			state.raw.mod = reader.string();
			state.raw.gamemode = reader.string();
			state.raw.description = reader.string();
			state.raw.version = reader.string();
			state.raw.port = reader.uint(2);
			state.raw.numplayers = reader.uint(1);
			state.maxplayers = reader.uint(1);
			state.raw.listentype = String.fromCharCode(reader.uint(1));
			state.raw.environment = String.fromCharCode(reader.uint(1));
			state.password = !!reader.uint(1);
			state.raw.secure = reader.uint(1);
			state.raw.averagefps = reader.uint(1);
			state.raw.round = reader.uint(1);
			state.raw.maxrounds = reader.uint(1);
			state.raw.timeleft = reader.uint(2);
			c();
		});
	}
});
