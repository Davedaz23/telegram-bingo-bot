// models/Game.js
const gameSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  // REMOVE: hostId field
  status: { type: String, enum: ['WAITING', 'ACTIVE', 'FINISHED', 'CANCELLED'], default: 'WAITING' },
  maxPlayers: { type: Number, default: 10 },
  currentPlayers: { type: Number, default: 0 },
  numbersCalled: [{ type: Number }],
  winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isPrivate: { type: Boolean, default: false },
  isAutoCreated: { type: Boolean, default: false },
  startedAt: { type: Date },
  endedAt: { type: Date }
}, {
  timestamps: true
});