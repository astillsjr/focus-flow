import { Collection, Db, MongoServerError } from "npm:mongodb";
import { Empty, ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Collection prefix to avoid name clashes
const PREFIX = "MicroBet" + ".";

// Generic types for the concept's external dependencies
type User = ID;
type Task = ID;

// Define the types for our entires based on the concept state
type Bet = ID;

/**
 * a set of Users with
 *   a points Number
 *   a streak Number
 */
interface UserDoc {
  _id: User;
  points: number;
  streak: number;
}

/**
 * a set of Bets with
 *   a user User
 *   a task Task
 *   a wager Number
 *   a deadline Date
 *   a success? Boolean
 */
interface BetDoc {
  _id: Bet;
  user: User;
  task: Task;
  wager: number;
  deadline: Date;
  success?: boolean;
  createdAt: Date;
}

export default class MicroBetConcept {
  users: Collection<UserDoc>;
  bets: Collection<BetDoc>;

  constructor(private readonly db: Db) {
    this.users = this.db.collection(PREFIX + "users");
    this.bets = this.db.collection(PREFIX + "bets");

    this.bets.createIndex({ user: 1, task: 1 }, { unique: true }).catch((err) => {
      console.error("Failed to create bets index:", err);
    });
  }

  /**
   * Initializes a user in the betting system.
   * @requires The user must not already be registered as a bettor.
   * @effects Creates a new betting profile for the user with 100 points and a streak of 0.
   */
  public async initializeBettor(
    { user }: { user: User },
  ): Promise<Empty | { error: string }> {
    const userProfile = await this.users.findOne({ _id: user });
    if (userProfile) return { error: "User already initialized" };

    await this.users.insertOne({ _id: user, points: 100, streak: 0 });
    return {};
  }

  /**
   * Removes a user and their bets from the system.
   * @effects Deletes the user's profile and all bets placed by them.
   */
  public async removeBettor(
    { user }: { user: User },
  ): Promise<Empty> {
    await Promise.all([
      this.users.deleteOne({ _id: user }),
      this.bets.deleteMany({ user })
    ]);

    return {};
  }

  /**
   * Places a new bet on a task.
   * @requires The user must have a betting profile. 
   *           No existing bet must exist for the same task. 
   *           The user must have at least `wager` points. 
   *           The bet deadline must be in the future.
   * @effects Creates a bet on the task and deducts the wager amount from the user's points.
   */
  public async placeBet({
    user, task, wager, deadline
  }: {
    user: User;
    task: Task;
    wager: number;
    deadline: Date;
  }): Promise<{ bet: Bet } | { error: string }> {
    if (deadline.getTime() < Date.now()) return { error: "Deadline must be in the future" };

    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };
    if (userProfile.points < wager) return { error: "Insufficient points to wager" };

    const newBet: BetDoc = {
      _id: freshID(),
      user,
      task,
      wager,
      deadline,
      createdAt: new Date(),
    }

    try {
      const updated = await this.users.updateOne(
        { _id: user, points: { $gte: wager } },
        { $inc: { points: -wager } }
      );
      if (updated.modifiedCount === 0) return { error: "Failed to deduct points" };

      await this.bets.insertOne(newBet);
      return { bet: newBet._id };
    } catch (_err) {
      await this.users.updateOne({ _id: user }, { $inc: { points: wager } });
      return { error: "Failed to place bet" }
    }
  }

  /**
   * Cancels an existing bet.
   * @requires The user must have a betting profile.
   *           The bet must exist and belong to the user.
   * @effects Deletes the bet. 
   *          If the bet is unresolved, refunds the wagered points to the user.
   */
  public async cancelBet(
    { user, task }: { user: User, task: Task }
  ): Promise<Empty | { error: string }> {
    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };

    const betDoc = await this.bets.findOne({ user, task });
    if (!betDoc) return { error: "Bet not found" };

    await this.bets.deleteOne({ _id: betDoc._id });

    // Refund only if unresolved
    if (betDoc.success === undefined) {
      await this.users.updateOne({ _id: user }, { $inc: { points: betDoc.wager } });
    }

    return {};
  }

  /**
   * Resolves a bet when a task is completed.
   * @requires The user must have a betting profile. 
   *           The bet must exist and belong to the user.
   *           The completion time must not exceed the deadline.
   * @effects If unresolved, marks the bet as successful, 
   *          awards a calculated reward to the user, and increments their streak. 
   *          Otherwise, reports that the bet was already resolved.
   */
  public async resolveBet(
    { user, task, completionTime }: { user: User, task: Task, completionTime: Date },
  ): Promise<
    { status: "already_resolved" } | 
    { status: "success", reward: number } | 
    { error: string }
  > {
    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };

    const betDoc = await this.bets.findOne({ user, task });
    if (!betDoc) return { error: "Bet for this task does not exist" };

    if (betDoc.success !== undefined) {
      return { status: "already_resolved" };
    }

    if (completionTime > betDoc.deadline) {
      return { error: "Cannot resolve: deadline has passed" }; 
    }

    const reward = this.calculateReward(betDoc.wager, userProfile.streak + 1);

    await Promise.all([
      this.bets.updateOne({ _id: betDoc._id }, { $set: { success: true } }),
      this.users.updateOne({ _id: user }, { $inc: { points: reward, streak: 1 } }),
    ]);

    return { status: "success", reward };
  }

  /**
   * Resolves a bet that has passed its deadline.
   * @requires The user must have a betting profile. 
   *           The bet must exist and belong to the user.  
   *           The deadline must have already passed.
   * @effects If unresolved, marks the bet as failed and resets the user's streak. 
   *          Otherwise, reports that the bet was already resolved.
   */
  public async resolveExpiredBet (
    { user, task }: { user: User, task: Task }
  ): Promise<Empty| { status: "already_resolved" } | { error: string }> {
    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };

    const betDoc = await this.bets.findOne({ user, task });
    if (!betDoc) return { error: "Bet not found" };

    if (betDoc.success !== undefined) return { status: "already_resolved" };

    if (betDoc.deadline.getTime() > Date.now()) {
      return { error: "Deadline has not yet passed" };
    }

    await Promise.all([
      this.bets.updateOne({ _id: betDoc._id }, { $set: { success: false } }),
      this.users.updateOne({ _id: user }, { $set: { streak: 0 } }),
    ]);

    return {};
  }

  /**
   * Retrieves a specific bet for a user.
   * @requires The user must have a betting profile, and a bet must exist for the task.
   * @effects Returns the corresponding bet document.
   */
  public async getBet(
    { user, task }: { user: User, task: Task }
  ): Promise<BetDoc | { error: string }> {
    const bet = await this.bets.findOne({ user, task });
    return bet ?? { error: "Bet not found" };
  }

  /**
   * Retrieves all active (unresolved) bets for a user.
   * @requires The user must have a betting profile.
   * @effects Returns all bets that are still active and unresolved.
   */
  public async getActiveBets(
    { user }: { user: User }
  ): Promise<BetDoc[] | { error: string }> {
    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };

    return this.bets.find({ user, success: { $exists: false } }).toArray();
  }

  /**
   * Retrieves all expired (unresolved and past-deadline) bets for a user.
   * @requires The user must have a betting profile.
   * @effects Returns bets that have passed their deadlines but have not been resolved.
   */
  public async getExpiredBets(
    { user }: { user: User }
  ): Promise<BetDoc[] | { error: string }> {
    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };
    
    return this.bets.find({
      user,
      success: { $exists: false },
      deadline: { $lt: new Date() },
    }).toArray();
  }

  /**
   * Retrieves the user's overall betting profile and statistics.
   * @requires The user must have a betting profile.
   * @effects Returns aggregated statistics on points, streak, and bet outcomes.
   */
  public async getUserProfile(
    { user }: { user: User }
  ): Promise<{
    points: number;
    streak: number;
    totalBets: number;
    successfulBets: number;
    failedBets: number;
    pendingBets: number;
  } | { error: string }> {
    const profile = await this.users.findOne({ _id: user });
    if (!profile) return { error: "User profile not found" };

    const [totalBets, successfulBets, failedBets, pendingBets] = await Promise.all([
      this.bets.countDocuments({ user }),
      this.bets.countDocuments({ user, success: true }),
      this.bets.countDocuments({ user, success: false }),
      this.bets.countDocuments({ user, success: { $exists: false } })
    ]);

    return {
      points: profile.points,
      streak: profile.streak,
      totalBets,
      successfulBets,
      failedBets,
      pendingBets
    };
  }

  /**
   * Retrieves recent betting activity for a user.
   * @requires The user must have a betting profile.
   * @effects Returns the user's most recent bets, sorted by creation time.
   */
  public async getRecentActivity(
    { user, limit = 10 }: { user: User; limit?: number }
  ): Promise<BetDoc[] | { error: string }> {
    const userProfile = await this.users.findOne({ _id: user });
    if (!userProfile) return { error: "User profile not found" };

    return await this.bets
      .find({ user })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Calculates the reward amount for a successful bet.
   * @effects Returns the computed reward based on the wager and user's streak.
   */
  private calculateReward (wager: number, streak: number): number {
    const STREAK_MULTIPLIER = 0.15;
    const streakBonus = Math.log(Math.log(streak + Math.E));
    const reward = wager * (1 + STREAK_MULTIPLIER * streakBonus);
    
    return Math.round(reward);
  }
}