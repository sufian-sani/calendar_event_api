// server.js
import express from 'express';
import mongoose from 'mongoose';
import bodyParser from 'body-parser';

const app = express();
app.use(bodyParser.json());

// --- Mock Authentication Middleware ---
const mockAuth = (req, res, next) => {
  // For demo, assign a static user and admin flag
  // In real life, extract from token/session
  req.user = {
    userId: 'user123',
    isAdmin: false,
  };
  next();
};

app.use(mockAuth);

// --- Mongoose setup ---
mongoose.connect('mongodb://localhost:27017/calendar', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// --- Event Schema ---

const eventSchema = new mongoose.Schema({
  title: String,
  description: String,
  startTime: Date,
  endTime: Date,
  participants: [String], // user IDs
  creator: String, // userId
  recurrence: {
    type: String,
    enum: ['none', 'daily', 'weekly', 'monthly'],
    default: 'none',
  },
  parentEvent: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null }, // for overrides
  recurrenceUpdateOption: {
    type: String,
    enum: ['thisEvent', 'thisAndFollowing', 'allEvents', null],
    default: null,
  },
});

const Event = mongoose.model('Event', eventSchema);

// Helper: Check permission
const canEdit = (user, event) => {
  return user.isAdmin || user.userId === event.creator;
};

// --- POST /events --- Create event with optional recurrence
app.post('/events', async (req, res) => {
  try {
    const {
      title,
      description,
      startTime,
      endTime,
      participants = [],
      recurrence = 'none',
    } = req.body;

    if (!title || !startTime || !endTime) {
      return res.status(400).json({ message: 'title, startTime and endTime required' });
    }

    if (!['none', 'daily', 'weekly', 'monthly'].includes(recurrence)) {
      return res.status(400).json({ message: 'Invalid recurrence value' });
    }

    const event = new Event({
      title,
      description,
      startTime,
      endTime,
      participants,
      recurrence,
      creator: req.user.userId,
    });

    await event.save();
    res.status(201).json(event);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PUT /events/:eventId --- Update event with recurrence options
app.put('/events/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const {
      title,
      description,
      startTime,
      endTime,
      addParticipants = [],
      removeParticipants = [],
      recurrenceUpdateOption = 'thisEvent', // default option
    } = req.body;

    if (!['thisEvent', 'thisAndFollowing', 'allEvents'].includes(recurrenceUpdateOption)) {
      return res.status(400).json({ message: 'Invalid recurrenceUpdateOption' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (!canEdit(req.user, event)) {
      return res.status(403).json({ message: 'No permission to update this event' });
    }

    // Handle each recurrenceUpdateOption differently
    if (recurrenceUpdateOption === 'thisEvent') {
      // Update only this instance (create override if recurring)
      if (event.recurrence === 'none' || event.parentEvent) {
        // single event or already override
        if (title !== undefined) event.title = title;
        if (description !== undefined) event.description = description;
        if (startTime !== undefined) event.startTime = new Date(startTime);
        if (endTime !== undefined) event.endTime = new Date(endTime);

        // Add/remove participants
        const currentParts = new Set(event.participants);
        addParticipants.forEach((p) => currentParts.add(p));
        removeParticipants.forEach((p) => currentParts.delete(p));
        event.participants = Array.from(currentParts);

        await event.save();
        return res.json(event);
      } else {
        // Recurring series, create override event for this occurrence
        const override = new Event({
          title: title !== undefined ? title : event.title,
          description: description !== undefined ? description : event.description,
          startTime: startTime !== undefined ? new Date(startTime) : event.startTime,
          endTime: endTime !== undefined ? new Date(endTime) : event.endTime,
          participants: event.participants.slice(),
          creator: event.creator,
          recurrence: 'none', // overrides are single events
          parentEvent: event._id,
          recurrenceUpdateOption: 'thisEvent',
        });

        // Apply participant changes
        const currentParts = new Set(override.participants);
        addParticipants.forEach((p) => currentParts.add(p));
        removeParticipants.forEach((p) => currentParts.delete(p));
        override.participants = Array.from(currentParts);

        await override.save();
        return res.json(override);
      }
    }

    if (recurrenceUpdateOption === 'thisAndFollowing') {
      // Update this event and all future occurrences
      if (event.recurrence === 'none' && !event.parentEvent) {
        // Single event: just update it
        if (title !== undefined) event.title = title;
        if (description !== undefined) event.description = description;
        if (startTime !== undefined) event.startTime = new Date(startTime);
        if (endTime !== undefined) event.endTime = new Date(endTime);

        // Add/remove participants
        const currentParts = new Set(event.participants);
        addParticipants.forEach((p) => currentParts.add(p));
        removeParticipants.forEach((p) => currentParts.delete(p));
        event.participants = Array.from(currentParts);

        await event.save();
        return res.json(event);
      }

      // For recurring events or overrides, we update the base event start from current event time
      let baseEventId;
      let baseEvent;

      if (event.parentEvent) {
        baseEventId = event.parentEvent;
      } else {
        baseEventId = event._id;
      }

      baseEvent = await Event.findById(baseEventId);
      if (!baseEvent) return res.status(404).json({ message: 'Base event not found' });

      if (!canEdit(req.user, baseEvent)) {
        return res.status(403).json({ message: 'No permission to update this event series' });
      }

      // Change base event startTime and endTime if provided to the current event's occurrence start time
      // and then create a new event to represent the modified series from this date forward

      // Calculate new start time if provided, else keep
      const newStartTime = startTime !== undefined ? new Date(startTime) : event.startTime;
      const newEndTime = endTime !== undefined ? new Date(endTime) : event.endTime;

      // Cut off the existing base event recurrence until the occurrence before this event start
      // by adjusting recurrence or ending time - **for simplicity, let's remove all events in the series
      // starting from this occurrence and recreate a new event with updated info**

      // Remove overrides related to base event from this event's startTime forward
      await Event.deleteMany({
        $or: [
          { _id: event._id },
          { parentEvent: baseEvent._id },
        ],
        startTime: { $gte: event.startTime },
        recurrenceUpdateOption: { $in: ['thisEvent', 'thisAndFollowing'] },
      });

      // Update baseEvent's endTime to just before this event start to break series
      // or in this simplified model, let's just set recurrence to 'none' for base event before the new event
      baseEvent.recurrence = 'none';
      await baseEvent.save();

      // Create new event series starting at newStartTime
      const newEventSeries = new Event({
        title: title !== undefined ? title : baseEvent.title,
        description: description !== undefined ? description : baseEvent.description,
        startTime: newStartTime,
        endTime: newEndTime,
        participants: baseEvent.participants.slice(),
        recurrence: baseEvent.recurrence,
        creator: baseEvent.creator,
      });

      // Participants add/remove
      const currentParts = new Set(newEventSeries.participants);
      addParticipants.forEach((p) => currentParts.add(p));
      removeParticipants.forEach((p) => currentParts.delete(p));
      newEventSeries.participants = Array.from(currentParts);

      await newEventSeries.save();

      return res.json(newEventSeries);
    }

    if (recurrenceUpdateOption === 'allEvents') {
      // Update all occurrences of this series (including overrides)

      let baseEventId;
      if (event.parentEvent) {
        baseEventId = event.parentEvent;
      } else {
        baseEventId = event._id;
      }

      const baseEvent = await Event.findById(baseEventId);
      if (!baseEvent) return res.status(404).json({ message: 'Base event not found' });

      if (!canEdit(req.user, baseEvent)) {
        return res.status(403).json({ message: 'No permission to update this event series' });
      }

      // Update base event
      if (title !== undefined) baseEvent.title = title;
      if (description !== undefined) baseEvent.description = description;
      if (startTime !== undefined) baseEvent.startTime = new Date(startTime);
      if (endTime !== undefined) baseEvent.endTime = new Date(endTime);

      // Participants add/remove
      const currentParts = new Set(baseEvent.participants);
      addParticipants.forEach((p) => currentParts.add(p));
      removeParticipants.forEach((p) => currentParts.delete(p));
      baseEvent.participants = Array.from(currentParts);

      await baseEvent.save();

      // Delete all overrides for this series since the base event is updated
      await Event.deleteMany({ parentEvent: baseEvent._id });

      return res.json(baseEvent);
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- DELETE /events/:eventId --- Delete event with recurrence options
app.delete('/events/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { recurrenceDeleteOption = 'thisEvent' } = req.body;

    if (!['thisEvent', 'thisAndFollowing', 'allEvents'].includes(recurrenceDeleteOption)) {
      return res.status(400).json({ message: 'Invalid recurrenceDeleteOption' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (!canEdit(req.user, event)) {
      return res.status(403).json({ message: 'No permission to delete this event' });
    }

    if (recurrenceDeleteOption === 'thisEvent') {
      if (event.recurrence === 'none' || event.parentEvent) {
        // Single event or override: delete it directly
        await event.deleteOne();
        return res.json({ message: 'Event deleted' });
      } else {
        // Recurring event series: create an override "skip" for this occurrence
        // For simplicity, create an override event flagged as cancelled
        const skipEvent = new Event({
          title: event.title,
          description: event.description,
          startTime: event.startTime,
          endTime: event.endTime,
          participants: event.participants,
          creator: event.creator,
          recurrence: 'none',
          parentEvent: event._id,
          recurrenceUpdateOption: 'thisEvent',
          cancelled: true,
        });
        await skipEvent.save();
        return res.json({ message: 'This event occurrence cancelled' });
      }
    }

    if (recurrenceDeleteOption === 'thisAndFollowing') {
      // Delete this and all future occurrences
      let baseEventId = event.parentEvent ? event.parentEvent : event._id;

      // Permission check on base event
      const baseEvent = await Event.findById(baseEventId);
      if (!baseEvent) return res.status(404).json({ message: 'Base event not found' });

      if (!canEdit(req.user, baseEvent)) {
        return res.status(403).json({ message: 'No permission to delete this event series' });
      }

      // Delete event and overrides from this startTime forward
      await Event.deleteMany({
        $or: [
          { _id: event._id },
          { parentEvent: baseEvent._id },
        ],
        startTime: { $gte: event.startTime },
        recurrenceUpdateOption: { $in: ['thisEvent', 'thisAndFollowing'] },
      });

      // Adjust base event recurrence or endTime to end before event start (optional, simplified here)
      baseEvent.recurrence = 'none';
      await baseEvent.save();

      return res.json({ message: 'This and following events deleted' });
    }

    if (recurrenceDeleteOption === 'allEvents') {
      // Delete entire series including overrides
      let baseEventId = event.parentEvent ? event.parentEvent : event._id;
      const baseEvent = await Event.findById(baseEventId);

      if (!baseEvent) return res.status(404).json({ message: 'Base event not found' });

      if (!canEdit(req.user, baseEvent)) {
        return res.status(403).json({ message: 'No permission to delete this event series' });
      }

      await Event.deleteMany({ $or: [{ _id: baseEvent._id }, { parentEvent: baseEvent._id }] });

      return res.json({ message: 'All events in series deleted' });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- GET /myevents --- Return all user's events structured with recurrence
app.get('/myevents', async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch all events where user is creator or participant
    const events = await Event.find({
      $or: [{ creator: userId }, { participants: userId }],
    }).lean();

    // Group base events and overrides by series
    const seriesMap = new Map();

    events.forEach((e) => {
      const baseId = e.parentEvent ? e.parentEvent.toString() : e._id.toString();

      if (!seriesMap.has(baseId)) {
        seriesMap.set(baseId, {
          baseEvent: null,
          overrides: [],
        });
      }

      if (!e.parentEvent) {
        seriesMap.get(baseId).baseEvent = e;
      } else {
        seriesMap.get(baseId).overrides.push(e);
      }
    });

    // Construct structured response
    const result = [];
    for (const [seriesId, data] of seriesMap.entries()) {
      if (!data.baseEvent) continue; // Ignore orphan overrides if any

      // For simplicity, return base event and overrides separately
      result.push({
        seriesId,
        baseEvent: data.baseEvent,
        overrides: data.overrides,
      });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Start Server ---
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
