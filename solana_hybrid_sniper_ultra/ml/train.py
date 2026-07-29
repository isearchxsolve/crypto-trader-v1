import pandas as pd
import numpy as np
import xgboost as xgb
import pickle
import os
from sklearn.model_selection import train_test_split, StratifiedKFold, cross_val_score
from sklearn.metrics import classification_report, accuracy_score, f1_score

FEATURE_COLUMNS = [
    "age_seconds",
    "liquidity_usd",
    "volume_5m",
    "volume_1h",
    "volume_change_1m",
    "price_change_5m",
    "price_change_1h",
    "buy_pressure_5m",
    "buy_pressure_1h",
    "buy_sell_ratio",
    "tx_velocity_per_hour",
    "fdv",
    "liq_to_mcap",
]

REAL_DATA_PATH = os.path.join(os.path.dirname(__file__), "solana_real_launches.csv")

def load_real_data(min_rows=100):
    if not os.path.exists(REAL_DATA_PATH):
        return None
    try:
        df = pd.read_csv(REAL_DATA_PATH)
        required = [c for c in FEATURE_COLUMNS if c != "liq_to_mcap"] + ["label"]
        missing = [c for c in required if c not in df.columns]
        if missing:
            print(f"[REAL-DATA] Missing columns {missing}, skipping")
            return None
        if len(df) < min_rows:
            print(f"[REAL-DATA] Only {len(df)} rows (need {min_rows}), skipping")
            return None
        df = df.dropna(subset=required)
        if len(df) < min_rows:
            print(f"[REAL-DATA] Only {len(df)} valid rows after dropna, skipping")
            return None
        print(f"[REAL-DATA] Loaded {len(df)} real-labeled rows from solana_real_launches.csv")
        return df[FEATURE_COLUMNS + ["label"]]
    except Exception as e:
        print(f"[REAL-DATA] Failed to load: {e}")
        return None

def generate_training_data(n_samples=25000):
    np.random.seed(42)
    data = []

    for _ in range(n_samples):
        scenario = np.random.choice(
            ["real_pump", "fake_pump_dump", "organic_growth", "dump", "flat",
             "rug_pull", "whale_exit", "borderline_up", "borderline_down",
             "dead_cat_bounce", "low_liq_trap", "high_vol_bleed"],
            p=[0.08, 0.12, 0.06, 0.15, 0.18,
               0.08, 0.07, 0.08, 0.08,
               0.04, 0.03, 0.03]
        )

        if scenario == "real_pump":
            age = np.random.exponential(45) + 5
            liquidity = np.random.uniform(8000, 300000)
            vol_5m = np.random.uniform(2000, 80000)
            vol_1h = vol_5m * np.random.uniform(4, 12)
            price_change_5m = np.random.uniform(5, 60)
            price_change_1h = np.random.uniform(10, 150)
            buy_pressure_5m = np.random.uniform(0.62, 0.92)
            buy_pressure_1h = np.random.uniform(0.55, 0.82)
            buy_sell_ratio = np.random.uniform(1.5, 6.0)
            tx_velocity = np.random.uniform(150, 2500)
            fdv = np.random.uniform(50000, 3000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 1

        elif scenario == "fake_pump_dump":
            age = np.random.uniform(15, 400)
            liquidity = np.random.uniform(1000, 80000)
            vol_5m = np.random.uniform(1000, 60000)
            vol_1h = vol_5m * np.random.uniform(2, 8)
            price_change_5m = np.random.uniform(5, 80)
            price_change_1h = np.random.uniform(-20, 100)
            buy_pressure_5m = np.random.uniform(0.50, 0.85)
            buy_pressure_1h = np.random.uniform(0.25, 0.55)
            buy_sell_ratio = np.random.uniform(0.8, 3.5)
            tx_velocity = np.random.uniform(100, 3000)
            fdv = np.random.uniform(10000, 2000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "organic_growth":
            age = np.random.uniform(60, 600)
            liquidity = np.random.uniform(15000, 500000)
            vol_5m = np.random.uniform(1000, 30000)
            vol_1h = vol_5m * np.random.uniform(6, 15)
            price_change_5m = np.random.uniform(2, 20)
            price_change_1h = np.random.uniform(5, 50)
            buy_pressure_5m = np.random.uniform(0.55, 0.75)
            buy_pressure_1h = np.random.uniform(0.52, 0.72)
            buy_sell_ratio = np.random.uniform(1.1, 3.0)
            tx_velocity = np.random.uniform(80, 800)
            fdv = np.random.uniform(100000, 5000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 1

        elif scenario == "dump":
            age = np.random.uniform(60, 7200)
            liquidity = np.random.uniform(1000, 500000)
            vol_5m = np.random.uniform(100, 20000)
            vol_1h = vol_5m * np.random.uniform(1, 8)
            price_change_5m = np.random.uniform(-50, -3)
            price_change_1h = np.random.uniform(-70, -5)
            buy_pressure_5m = np.random.uniform(0.10, 0.45)
            buy_pressure_1h = np.random.uniform(0.15, 0.48)
            buy_sell_ratio = np.random.uniform(0.1, 0.8)
            tx_velocity = np.random.uniform(30, 600)
            fdv = np.random.uniform(10000, 10000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "flat":
            age = np.random.uniform(300, 86400)
            liquidity = np.random.uniform(10000, 2000000)
            vol_5m = np.random.uniform(10, 3000)
            vol_1h = vol_5m * np.random.uniform(5, 20)
            price_change_5m = np.random.uniform(-3, 3)
            price_change_1h = np.random.uniform(-5, 5)
            buy_pressure_5m = np.random.uniform(0.40, 0.60)
            buy_pressure_1h = np.random.uniform(0.42, 0.58)
            buy_sell_ratio = np.random.uniform(0.7, 1.3)
            tx_velocity = np.random.uniform(5, 150)
            fdv = np.random.uniform(100000, 50000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "rug_pull":
            age = np.random.uniform(5, 300)
            liquidity = np.random.uniform(100, 3000)
            vol_5m = np.random.uniform(2000, 150000)
            vol_1h = vol_5m * np.random.uniform(1, 4)
            price_change_5m = np.random.choice([
                np.random.uniform(20, 300),
                np.random.uniform(-95, -40)
            ])
            price_change_1h = np.random.uniform(-90, 80)
            buy_pressure_5m = np.random.uniform(0.05, 0.90)
            buy_pressure_1h = np.random.uniform(0.10, 0.45)
            buy_sell_ratio = np.random.uniform(0.05, 2.5)
            tx_velocity = np.random.uniform(300, 8000)
            fdv = np.random.uniform(3000, 300000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "whale_exit":
            age = np.random.uniform(120, 3600)
            liquidity = np.random.uniform(5000, 200000)
            vol_5m = np.random.uniform(5000, 100000)
            vol_1h = vol_5m * np.random.uniform(2, 6)
            price_change_5m = np.random.uniform(-30, 5)
            price_change_1h = np.random.uniform(-40, -5)
            buy_pressure_5m = np.random.uniform(0.20, 0.50)
            buy_pressure_1h = np.random.uniform(0.30, 0.55)
            buy_sell_ratio = np.random.uniform(0.3, 1.0)
            tx_velocity = np.random.uniform(50, 500)
            fdv = np.random.uniform(50000, 5000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "borderline_up":
            age = np.random.uniform(30, 400)
            liquidity = np.random.uniform(5000, 150000)
            vol_5m = np.random.uniform(500, 20000)
            vol_1h = vol_5m * np.random.uniform(3, 10)
            price_change_5m = np.random.uniform(1, 12)
            price_change_1h = np.random.uniform(-3, 25)
            buy_pressure_5m = np.random.uniform(0.52, 0.68)
            buy_pressure_1h = np.random.uniform(0.48, 0.63)
            buy_sell_ratio = np.random.uniform(1.0, 2.2)
            tx_velocity = np.random.uniform(60, 500)
            fdv = np.random.uniform(40000, 4000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 1

        elif scenario == "borderline_down":
            age = np.random.uniform(30, 400)
            liquidity = np.random.uniform(3000, 120000)
            vol_5m = np.random.uniform(400, 18000)
            vol_1h = vol_5m * np.random.uniform(2, 9)
            price_change_5m = np.random.uniform(-8, 10)
            price_change_1h = np.random.uniform(-15, 12)
            buy_pressure_5m = np.random.uniform(0.38, 0.58)
            buy_pressure_1h = np.random.uniform(0.38, 0.58)
            buy_sell_ratio = np.random.uniform(0.6, 1.6)
            tx_velocity = np.random.uniform(30, 400)
            fdv = np.random.uniform(30000, 3000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "dead_cat_bounce":
            age = np.random.uniform(300, 7200)
            liquidity = np.random.uniform(2000, 50000)
            vol_5m = np.random.uniform(500, 15000)
            vol_1h = vol_5m * np.random.uniform(1, 5)
            price_change_5m = np.random.uniform(5, 40)
            price_change_1h = np.random.uniform(-60, -10)
            buy_pressure_5m = np.random.uniform(0.50, 0.75)
            buy_pressure_1h = np.random.uniform(0.20, 0.45)
            buy_sell_ratio = np.random.uniform(0.8, 2.5)
            tx_velocity = np.random.uniform(50, 400)
            fdv = np.random.uniform(20000, 2000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        elif scenario == "low_liq_trap":
            age = np.random.uniform(10, 200)
            liquidity = np.random.uniform(500, 4000)
            vol_5m = np.random.uniform(3000, 80000)
            vol_1h = vol_5m * np.random.uniform(1, 4)
            price_change_5m = np.random.uniform(10, 150)
            price_change_1h = np.random.uniform(-20, 200)
            buy_pressure_5m = np.random.uniform(0.55, 0.90)
            buy_pressure_1h = np.random.uniform(0.30, 0.60)
            buy_sell_ratio = np.random.uniform(1.0, 5.0)
            tx_velocity = np.random.uniform(200, 5000)
            fdv = np.random.uniform(5000, 200000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        else:  # high_vol_bleed
            age = np.random.uniform(60, 3600)
            liquidity = np.random.uniform(10000, 300000)
            vol_5m = np.random.uniform(5000, 50000)
            vol_1h = vol_5m * np.random.uniform(3, 10)
            price_change_5m = np.random.uniform(-15, -1)
            price_change_1h = np.random.uniform(-25, 5)
            buy_pressure_5m = np.random.uniform(0.35, 0.55)
            buy_pressure_1h = np.random.uniform(0.40, 0.55)
            buy_sell_ratio = np.random.uniform(0.5, 1.2)
            tx_velocity = np.random.uniform(100, 1000)
            fdv = np.random.uniform(100000, 10000000)
            liq_to_mcap = liquidity / (fdv + 1e-9)
            label = 0

        vol_momentum = vol_5m / (vol_1h / 12 + 1e-9)
        noise = lambda v, pct=0.12: v * (1 + np.random.normal(0, pct))

        bp_consistency = min(buy_pressure_5m, buy_pressure_1h) / (max(buy_pressure_5m, buy_pressure_1h) + 1e-9)
        vol_to_liq = vol_5m / (liquidity + 1e-9)

        data.append({
            "age_seconds": max(1, noise(age, 0.15)),
            "liquidity_usd": max(0, noise(liquidity, 0.15)),
            "volume_5m": max(0, noise(vol_5m, 0.15)),
            "volume_1h": max(0, noise(vol_1h, 0.15)),
            "volume_change_1m": max(0, noise(vol_momentum, 0.20)),
            "price_change_5m": noise(price_change_5m, 0.15),
            "price_change_1h": noise(price_change_1h, 0.15),
            "buy_pressure_5m": np.clip(noise(buy_pressure_5m, 0.10), 0, 1),
            "buy_pressure_1h": np.clip(noise(buy_pressure_1h, 0.10), 0, 1),
            "buy_sell_ratio": max(0, noise(buy_sell_ratio, 0.20)),
            "tx_velocity_per_hour": max(0, noise(tx_velocity, 0.15)),
            "fdv": max(0, noise(fdv, 0.15)),
            "liq_to_mcap": max(0, noise(liq_to_mcap, 0.20)),
            "label": label,
        })

    return pd.DataFrame(data)


def train_model():
    print("Generating realistic training dataset (25000 samples, 12 scenarios)...")
    df = generate_training_data(25000)

    # REAL DATA INJECTION - close OD-1 by training on actual market outcomes
    real_df = load_real_data(min_rows=50)
    if real_df is not None and len(real_df) > 0:
        real_pump = int(real_df["label"].sum())
        real_nonpump = len(real_df) - real_pump
        if real_pump > 0 and real_nonpump > 0:
            n_extra_pumps = max(0, len(df[df["label"] == 1]) - real_pump)
            n_extra_nonpumps = max(0, len(df[df["label"] == 0]) - real_nonpump)
            pumps_to_add = real_df[real_df["label"] == 1].sample(n=min(n_extra_pumps, real_pump * 3), replace=True, random_state=42) if n_extra_pumps > 0 else pd.DataFrame()
            nonpumps_to_add = real_df[real_df["label"] == 0].sample(n=min(n_extra_nonpumps, real_nonpump * 3), replace=True, random_state=42) if n_extra_nonpumps > 0 else pd.DataFrame()
            if len(pumps_to_add) > 0 or len(nonpumps_to_add) > 0:
                real_augmented = pd.concat([pumps_to_add, nonpumps_to_add], ignore_index=True)
                df = pd.concat([df, real_augmented], ignore_index=True)
                print(f"[REAL-DATA] Augmented with {len(real_augmented)} real rows -> total {len(df)} samples")
        else:
            print("[REAL-DATA] Insufficient real pump/non-pump samples, using synthetic only")

    pump_count = int(df['label'].sum())
    nonpump_count = len(df) - pump_count
    print(f"Dataset: {len(df)} samples | Pumps: {pump_count} ({df['label'].mean()*100:.1f}%) | Non-pumps: {nonpump_count}")

    X = df[FEATURE_COLUMNS]
    y = df["label"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    print(f"Train: {len(X_train)} samples | Test: {len(X_test)} samples")

    neg_weight = (1 - y_train.mean()) / y_train.mean()

    model = xgb.XGBClassifier(
        n_estimators=800,
        max_depth=5,
        learning_rate=0.03,
        subsample=0.75,
        colsample_bytree=0.75,
        min_child_weight=8,
        gamma=0.5,
        reg_alpha=0.3,
        reg_lambda=2.0,
        scale_pos_weight=neg_weight * 0.8,
        eval_metric="logloss",
        early_stopping_rounds=40,
        random_state=42,
    )

    print("Training XGBoost v4.0 with heavy regularization...")
    model.fit(
        X_train, y_train,
        eval_set=[(X_train, y_train), (X_test, y_test)],
        verbose=False,
    )
    print(f"Best iteration: {model.best_iteration}")

    train_preds = model.predict(X_train)
    test_preds = model.predict(X_test)

    test_probs = model.predict_proba(X_test)[:, 1]
    high_conf_mask = test_probs >= 0.65
    if high_conf_mask.sum() > 0:
        high_conf_acc = accuracy_score(y_test[high_conf_mask], test_preds[high_conf_mask])
        print(f"High confidence (>=65%) accuracy: {high_conf_acc:.4f} on {high_conf_mask.sum()} samples")

    medium_conf_mask = (test_probs >= 0.40) & (test_probs < 0.65)
    if medium_conf_mask.sum() > 0:
        medium_conf_acc = accuracy_score(y_test[medium_conf_mask], test_preds[medium_conf_mask])
        print(f"Medium confidence (40-65%) accuracy: {medium_conf_acc:.4f} on {medium_conf_mask.sum()} samples")

    train_acc = accuracy_score(y_train, train_preds)
    test_acc = accuracy_score(y_test, test_preds)
    train_f1 = f1_score(y_train, train_preds)
    test_f1 = f1_score(y_test, test_preds)

    print(f"\nTrain accuracy: {train_acc:.4f} | Test accuracy: {test_acc:.4f} | Gap: {abs(train_acc - test_acc)*100:.2f}%")
    print(f"Train F1:       {train_f1:.4f} | Test F1:       {test_f1:.4f} | Gap: {abs(train_f1 - test_f1)*100:.2f}%")

    print(f"\nTest Set Classification Report:")
    print(classification_report(y_test, test_preds, target_names=["Non-pump", "Pump"]))

    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    cv_model = xgb.XGBClassifier(
        n_estimators=model.best_iteration,
        max_depth=5,
        learning_rate=0.03,
        subsample=0.75,
        colsample_bytree=0.75,
        min_child_weight=8,
        gamma=0.5,
        reg_alpha=0.3,
        reg_lambda=2.0,
        scale_pos_weight=neg_weight * 0.8,
        eval_metric="logloss",
        random_state=42,
    )
    cv_acc = cross_val_score(cv_model, X, y, cv=skf, scoring="accuracy")
    cv_f1 = cross_val_score(cv_model, X, y, cv=skf, scoring="f1")
    print(f"Stratified 5-Fold CV accuracy: {cv_acc.mean():.4f} (+/- {cv_acc.std():.4f})")
    print(f"Stratified 5-Fold CV F1:       {cv_f1.mean():.4f} (+/- {cv_f1.std():.4f})")

    importances = model.feature_importances_
    print("\nFeature Importance:")
    for feat, imp in sorted(zip(FEATURE_COLUMNS, importances), key=lambda x: -x[1]):
        print(f"  {feat:30s} {imp:.4f}")

    os.makedirs("solana_hybrid_sniper_ultra/ml", exist_ok=True)
    model_path = "solana_hybrid_sniper_ultra/ml/model.pkl"
    with open(model_path, "wb") as f:
        pickle.dump({"model": model, "features": FEATURE_COLUMNS, "version": "5.0"}, f)
    print(f"\nModel v5.0 saved to {model_path}")

    csv_path = "solana_hybrid_sniper_ultra/ml/training_data.csv"
    df.to_csv(csv_path, index=False)
    print(f"Training data saved to {csv_path}")

    if abs(train_acc - test_acc) < 0.05:
        print("\n[OK] Train/test gap < 5% - No overfitting detected")
    else:
        print(f"\n[WARN] Train/test gap is {abs(train_acc - test_acc)*100:.2f}% - potential overfitting")


if __name__ == "__main__":
    train_model()
