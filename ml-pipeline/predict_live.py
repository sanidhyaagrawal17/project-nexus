from main import main, predict_from_csv_path


def run_live_inference(input_csv):
    return predict_from_csv_path(input_csv)


if __name__ == '__main__':
    main()